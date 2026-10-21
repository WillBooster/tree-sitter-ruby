#include "tree_sitter/alloc.h"
#include "tree_sitter/array.h"
#include "tree_sitter/parser.h"

#include <string.h>
#include <wctype.h>

_Static_assert(TREE_SITTER_SERIALIZATION_BUFFER_SIZE <= (UINT16_MAX >> 4),
               "Heredoc length flags must cover the serialization buffer");

typedef enum {
    LINE_BREAK,
    NO_LINE_BREAK,

    SIMPLE_SYMBOL,
    STRING_START,
    SYMBOL_START,
    SUBSHELL_START,
    REGEX_START,
    STRING_ARRAY_START,
    SYMBOL_ARRAY_START,
    HEREDOC_BODY_START,
    STRING_CONTENT,
    HEREDOC_CONTENT,
    STRING_END,
    HEREDOC_BODY_END,
    HEREDOC_START,

    FORWARD_SLASH,
    BLOCK_AMPERSAND,
    SPLAT_STAR,
    UNARY_PLUS,
    BINARY_PLUS,
    UNARY_MINUS,
    UNARY_MINUS_NUM,
    BINARY_MINUS,
    BINARY_STAR,
    BITWISE_AND,
    SINGLETON_CLASS_LEFT_ANGLE_LEFT_ANGLE,
    HASH_KEY_SYMBOL,
    IDENTIFIER_SUFFIX,
    CONSTANT_SUFFIX,
    HASH_SPLAT_STAR_STAR,
    BINARY_STAR_STAR,
    MODULO_ASSIGNMENT,
    ELEMENT_REFERENCE_BRACKET,
    SHORT_INTERPOLATION,
    LINE_COMMENT,
    BLOCK_COMMENT,
    UNINTERPRETED,
    NOT_PARENTHESIZED,
    LAMBDA_BRACE,
    HEREDOC_RESUME,

    NONE
} TokenType;

typedef Array(char) String;

typedef struct {
    TokenType type;
    int32_t open_delimiter;
    int32_t close_delimiter;
    int32_t nesting_depth;
    bool allows_interpolation;
    bool resume_after_heredoc;
} Literal;

typedef struct {
    String word;
    bool end_word_indentation_allowed;
    bool allows_interpolation;
    bool started;
    bool newline_consumed;
    bool host_line_continued;
    bool finished;
} Heredoc;

typedef struct {
    bool has_leading_whitespace;
    Array(Literal) literal_stack;
    Array(Heredoc) open_heredocs;
} Scanner;

const char NON_IDENTIFIER_CHARS[] = {
    '\0', '\n', '\r', '\t', ' ', ':', ';', '`',  '"', '\'', '@', '$', '#', '.', ',', '|', '^', '&',
    '<',  '=',  '>',  '+',  '-', '*', '/', '\\', '%', '?',  '!', '~', '(', ')', '[', ']', '{', '}',
};

static inline void skip(Scanner *scanner, TSLexer *lexer) {
    scanner->has_leading_whitespace = true;
    lexer->advance(lexer, true);
}

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

static inline void reset(Scanner *scanner) {
    array_delete(&scanner->literal_stack);
    for (uint32_t i = 0; i < scanner->open_heredocs.size; i++) {
        array_delete(&array_get(&scanner->open_heredocs, i)->word);
    }
    array_delete(&scanner->open_heredocs);
}

static inline unsigned serialize(Scanner *scanner, char *buffer) {
    unsigned size = 0;

    if (scanner->literal_stack.size * 6 + 2 >= TREE_SITTER_SERIALIZATION_BUFFER_SIZE) {
        return 0;
    }

    buffer[size++] = (char)scanner->literal_stack.size;
    for (uint32_t i = 0; i < scanner->literal_stack.size; i++) {
        Literal *literal = array_get(&scanner->literal_stack, i);
        buffer[size++] = literal->type;
        buffer[size++] = (char)literal->open_delimiter;
        buffer[size++] = (char)literal->close_delimiter;
        // Nested delimiters such as `%(((...)))` can exceed one byte of depth.
        if (literal->nesting_depth > UINT16_MAX) {
            return 0;
        }
        buffer[size++] = (char)(literal->nesting_depth & 0xFF);
        buffer[size++] = (char)(literal->nesting_depth >> 8);
        buffer[size++] = (char)(literal->allows_interpolation | (literal->resume_after_heredoc << 1));
    }

    buffer[size++] = (char)scanner->open_heredocs.size;
    for (uint32_t i = 0; i < scanner->open_heredocs.size; i++) {
        Heredoc *heredoc = array_get(&scanner->open_heredocs, i);
        if (heredoc->word.size > (UINT16_MAX >> 4) ||
            size + 4 + heredoc->word.size > TREE_SITTER_SERIALIZATION_BUFFER_SIZE) {
            return 0;
        }
        buffer[size++] = (char)heredoc->end_word_indentation_allowed;
        buffer[size++] = (char)heredoc->allows_interpolation;
        buffer[size++] = (char)(((heredoc->word.size >> 8) << 4) | (heredoc->finished << 3) | (heredoc->host_line_continued << 2) | (heredoc->newline_consumed << 1) | heredoc->started);
        buffer[size++] = (char)(heredoc->word.size & 0xFF);
        memcpy(&buffer[size], heredoc->word.contents, heredoc->word.size);
        size += heredoc->word.size;
    }

    return size;
}

static inline void deserialize(Scanner *scanner, const char *buffer, unsigned length) {
    unsigned size = 0;
    scanner->has_leading_whitespace = false;
    reset(scanner);

    if (length == 0) {
        return;
    }

    uint8_t literal_depth = buffer[size++];
    for (unsigned j = 0; j < literal_depth; j++) {
        Literal literal = {0};
        literal.type = (TokenType)(buffer[size++]);
        literal.open_delimiter = (unsigned char)buffer[size++];
        literal.close_delimiter = (unsigned char)buffer[size++];
        literal.nesting_depth = (unsigned char)buffer[size] | ((unsigned char)buffer[size + 1] << 8);
        size += 2;
        uint8_t literal_flags = (uint8_t)buffer[size++];
        literal.allows_interpolation = (literal_flags & 1) != 0;
        literal.resume_after_heredoc = (literal_flags & 2) != 0;
        array_push(&scanner->literal_stack, literal);
    }

    uint8_t open_heredoc_count = buffer[size++];
    for (unsigned j = 0; j < open_heredoc_count; j++) {
        Heredoc heredoc = {0};
        heredoc.end_word_indentation_allowed = buffer[size++];
        heredoc.allows_interpolation = buffer[size++];
        uint8_t state_and_length = (uint8_t)buffer[size++];
        heredoc.started = (state_and_length & 1) != 0;
        heredoc.newline_consumed = (state_and_length & 2) != 0;
        heredoc.host_line_continued = (state_and_length & 4) != 0;
        heredoc.finished = (state_and_length & 8) != 0;

        heredoc.word = (String)array_new();
        uint16_t word_length = ((uint16_t)(state_and_length >> 4) << 8) | (uint8_t)buffer[size++];
        array_reserve(&heredoc.word, word_length);
        memcpy(heredoc.word.contents, &buffer[size], word_length);
        heredoc.word.size = word_length;
        size += word_length;
        array_push(&scanner->open_heredocs, heredoc);
    }

    assert(size == length);
}

static inline bool scan_literal_resume(Literal *literal, TSLexer *lexer, const bool *valid_symbols);
static inline bool scan_heredoc_host_resume(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols);
static inline void finish_heredoc(Scanner *scanner, TSLexer *lexer, bool can_resume);
static inline bool has_pending_heredoc_body(Scanner *scanner, const bool *valid_symbols);
static inline bool scan_heredoc_after_literal_escape(Scanner *scanner, TSLexer *lexer, bool consume_plain_escape);
static inline bool finish_literal_content(TSLexer *lexer);
static inline bool scan_heredoc_after_literal_space(Scanner *scanner, TSLexer *lexer);
static inline bool is_horizontal_whitespace(int32_t codepoint);
static inline bool start_literal_heredoc_body(Scanner *scanner, TSLexer *lexer);
static inline bool start_heredoc_body(Scanner *scanner, TSLexer *lexer);
static inline void mark_current_heredoc_position(TSLexer *lexer);
static inline bool is_heredoc_word_character(int32_t codepoint);
static inline uint32_t encode_utf8(int32_t codepoint, char *bytes);
static inline void append_heredoc_character(String *word, int32_t codepoint);
static inline bool scan_line_comment(TSLexer *lexer);
static bool scan_splat(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols);
static bool scan_word_token(TSLexer *lexer, const bool *valid_symbols, bool rescue_may_end_line);
static bool scan_not_parentheses_gap(TSLexer *lexer);
static bool scan_embdoc(TSLexer *lexer);
static bool scan_word_text(TSLexer *lexer, const char *word);

static inline bool scan_whitespace(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols,
                                   bool *rescue_may_end_line) {
    bool heredoc_body_start_is_valid = has_pending_heredoc_body(scanner, valid_symbols);
    bool crossed_newline = false;

    for (;;) {
        if (!valid_symbols[NO_LINE_BREAK] && valid_symbols[LINE_BREAK] && lexer->is_at_included_range_start(lexer)) {
            lexer->mark_end(lexer);
            lexer->result_symbol = LINE_BREAK;
            return true;
        }

        switch (lexer->lookahead) {
            case ' ':
            case '\t':
            case '\f':
            case '\v':
                skip(scanner, lexer);
                break;
            case '\r':
                if (heredoc_body_start_is_valid) {
                    return start_heredoc_body(scanner, lexer);
                } else {
                    skip(scanner, lexer);
                    break;
                }
            case '\n':
                if (heredoc_body_start_is_valid) {
                    return start_heredoc_body(scanner, lexer);
                } else if (!valid_symbols[NO_LINE_BREAK] && valid_symbols[LINE_BREAK] && !crossed_newline) {
                    lexer->mark_end(lexer);
                    // Keep the saved LINE_BREAK endpoint, but exclude this newline from a following external token.
                    lexer->advance(lexer, true);
                    crossed_newline = true;
                } else {
                    // After a hash shorthand (`foo key:`) or `..`, the operand may follow on the next line unless that
                    // line starts a `rescue` clause.
                    *rescue_may_end_line = valid_symbols[NO_LINE_BREAK] && valid_symbols[LINE_BREAK];
                    skip(scanner, lexer);
                }
                break;
            case '\\': {
                advance(lexer);
                if (heredoc_body_start_is_valid && lexer->is_at_included_range_start(lexer)) return false;
                if (lexer->lookahead == '\r') {
                    skip(scanner, lexer);
                    if (heredoc_body_start_is_valid && lexer->is_at_included_range_start(lexer)) return false;
                }
                if (iswspace(lexer->lookahead)) {
                    bool starts_body = heredoc_body_start_is_valid && lexer->lookahead == '\n';
                    skip(scanner, lexer);
                    if (starts_body) {
                        array_get(&scanner->open_heredocs, 0)->host_line_continued = true;
                        mark_current_heredoc_position(lexer);
                        return start_heredoc_body(scanner, lexer);
                    }
                } else {
                    return false;
                }
                break;
            }
            default:
                if (crossed_newline) {
                    if (lexer->lookahead != '.' && lexer->lookahead != '&' && lexer->lookahead != '#') {
                        lexer->result_symbol = LINE_BREAK;
                    } else if (lexer->lookahead == '.') {
                        // Don't return LINE_BREAK for the call operator (`.`) but do return one for range
                        // operators
                        // (`..` and `...`)
                        advance(lexer);
                        if (!lexer->eof(lexer) && lexer->lookahead == '.') {
                            lexer->result_symbol = LINE_BREAK;
                        } else {
                            return false;
                        }
                    }
                }
                return true;
        }
    }
}

static inline bool scan_operator(TSLexer *lexer) {
    switch (lexer->lookahead) {
        case '<':
            advance(lexer);
            if (lexer->lookahead == '<') {
                advance(lexer);
            } else if (lexer->lookahead == '=') {
                advance(lexer);
                if (lexer->lookahead == '>') {
                    advance(lexer);
                }
            }
            return true;

        case '>':
            advance(lexer);
            if (lexer->lookahead == '>' || lexer->lookahead == '=') {
                advance(lexer);
            }
            return true;

        case '=':
            advance(lexer);
            if (lexer->lookahead == '~') {
                advance(lexer);
                return true;
            }
            if (lexer->lookahead == '=') {
                advance(lexer);
                if (lexer->lookahead == '=') {
                    advance(lexer);
                }
                return true;
            }
            return false;

        case '+':
        case '-':
        case '~':
            advance(lexer);
            if (lexer->lookahead == '@') {
                advance(lexer);
            }
            return true;

        case '.':
            advance(lexer);
            if (lexer->lookahead == '.') {
                advance(lexer);
                return true;
            }
            return false;

        case '&':
        case '^':
        case '|':
        case '/':
        case '%':
        case '`':
            advance(lexer);
            return true;

        case '!':
            advance(lexer);
            if (lexer->lookahead == '=' || lexer->lookahead == '~') {
                advance(lexer);
            }
            return true;

        case '*':
            advance(lexer);
            if (lexer->lookahead == '*') {
                advance(lexer);
            }
            return true;

        case '[':
            advance(lexer);
            if (lexer->lookahead == ']') {
                advance(lexer);
            } else {
                return false;
            }
            if (lexer->lookahead == '=') {
                advance(lexer);
            }
            return true;

        default:
            return false;
    }
}

static inline bool is_iden_char(int32_t c) {
    return c > 0x7f || memchr(&NON_IDENTIFIER_CHARS, c, sizeof(NON_IDENTIFIER_CHARS)) == NULL;
}

// Whether `c` ends a keyword instead of extending it into a name or a method name.
static inline bool ends_keyword(int32_t c) { return !is_iden_char(c) && c != '?' && c != '!'; }

static inline bool scan_symbol_identifier(TSLexer *lexer) {
    if (lexer->lookahead == '@') {
        advance(lexer);
        if (lexer->lookahead == '@') {
            advance(lexer);
        }
    } else if (lexer->lookahead == '$') {
        advance(lexer);
    }

    if (is_iden_char(lexer->lookahead)) {
        advance(lexer);
    } else if (!scan_operator(lexer)) {
        return false;
    }

    while (is_iden_char(lexer->lookahead)) {
        advance(lexer);
    }

    if (lexer->lookahead == '?' || lexer->lookahead == '!') {
        advance(lexer);
    }

    if (lexer->lookahead == '=') {
        lexer->mark_end(lexer);
        advance(lexer);
        if (lexer->lookahead != '>') {
            lexer->mark_end(lexer);
        }
    }

    return true;
}

// NO_LINE_BREAK is valid after `..` and `...` (an endless range) and after a hash shorthand (`foo key:`), where Ruby
// reads an operand on the same or the next line although binary operators are valid because the expression may
// already be complete. STRING_CONTENT is valid along with STRING_START only in error recovery.
static inline bool expects_operand_across_line_break(const bool *valid_symbols) {
    return valid_symbols[NO_LINE_BREAK] && !valid_symbols[STRING_CONTENT];
}

static inline bool scan_literal_start_or_assignment(Scanner *scanner, TSLexer *lexer, Literal *literal, const bool *valid_symbols) {
    const bool binary_operator_valid =
        valid_symbols[FORWARD_SLASH] && !expects_operand_across_line_break(valid_symbols);

    switch (lexer->lookahead) {
        case '"':
            literal->type = STRING_START;
            literal->open_delimiter = literal->close_delimiter = lexer->lookahead;
            literal->allows_interpolation = true;
            advance(lexer);
            return true;

        case '\'':
            literal->type = STRING_START;
            literal->open_delimiter = literal->close_delimiter = lexer->lookahead;
            literal->allows_interpolation = false;
            advance(lexer);
            return true;

        case '`':
            if (!valid_symbols[SUBSHELL_START]) {
                return false;
            }
            literal->type = SUBSHELL_START;
            literal->open_delimiter = literal->close_delimiter = lexer->lookahead;
            literal->allows_interpolation = true;
            advance(lexer);
            return true;

        case '/':
            if (!valid_symbols[REGEX_START]) {
                return false;
            }
            literal->type = REGEX_START;
            literal->open_delimiter = literal->close_delimiter = lexer->lookahead;
            literal->allows_interpolation = true;
            advance(lexer);
            if (binary_operator_valid) {
                if (!scanner->has_leading_whitespace) {
                    return false;
                }
                if (lexer->lookahead == ' ' || lexer->lookahead == '\t' || lexer->lookahead == '\n' ||
                    lexer->lookahead == '\r') {
                    return false;
                }
                if (lexer->lookahead == '=') {
                    return false;
                }
            }
            return true;

        case '%': {
            advance(lexer);
            if (valid_symbols[MODULO_ASSIGNMENT] && lexer->lookahead == '=') {
                advance(lexer);
                literal->type = MODULO_ASSIGNMENT;
                return true;
            }

            static const struct {
                int32_t prefix;
                TokenType type;
                bool allows_interpolation;
            } kinds[] = {
                {'s', SYMBOL_START, false},
                {'r', REGEX_START, true},
                {'x', SUBSHELL_START, true},
                {'q', STRING_START, false},
                {'Q', STRING_START, true},
                {'w', STRING_ARRAY_START, false},
                {'W', STRING_ARRAY_START, true},
                {'i', SYMBOL_ARRAY_START, false},
                {'I', SYMBOL_ARRAY_START, true},
            };
            literal->type = STRING_START;
            literal->allows_interpolation = true;
            for (unsigned i = 0; i < sizeof(kinds) / sizeof(kinds[0]); i++) {
                if (lexer->lookahead == kinds[i].prefix) {
                    literal->type = kinds[i].type;
                    literal->allows_interpolation = kinds[i].allows_interpolation;
                    advance(lexer);
                    break;
                }
            }
            TokenType required_token = literal->type == SYMBOL_START ? SIMPLE_SYMBOL : literal->type;
            if (!valid_symbols[required_token]) {
                return false;
            }

            switch (lexer->lookahead) {
                case '(':
                    literal->open_delimiter = '(';
                    literal->close_delimiter = ')';
                    break;

                case '[':
                    literal->open_delimiter = '[';
                    literal->close_delimiter = ']';
                    break;

                case '{':
                    literal->open_delimiter = '{';
                    literal->close_delimiter = '}';
                    break;

                case '<':
                    literal->open_delimiter = '<';
                    literal->close_delimiter = '>';
                    break;

                case '\r':
                case '\n':
                case ' ':
                case '\t':
                    // If the `/` operator is valid, then so is the `%` operator, which means
                    // that a `%` followed by whitespace should be considered an operator,
                    // not a percent string.
                    if (binary_operator_valid) {
                        return false;
                    }
                    literal->open_delimiter = lexer->lookahead;
                    literal->close_delimiter = lexer->lookahead;
                    break;

                case '|':
                case '!':
                case '#':
                case '/':
                case '\\':
                case '@':
                case '$':
                case '%':
                case '^':
                case '&':
                case '*':
                case ')':
                case ']':
                case '}':
                case '>':
                case '=':
                case '+':
                case '-':
                case '~':
                case '`':
                case ',':
                case '.':
                case '?':
                case ':':
                case ';':
                case '_':
                case '"':
                case '\'':
                    literal->open_delimiter = lexer->lookahead;
                    literal->close_delimiter = lexer->lookahead;
                    break;
                default:
                    return false;
            }

            advance(lexer);
            if (literal->close_delimiter == '\r' && lexer->lookahead == '\n' &&
                !lexer->is_at_included_range_start(lexer)) {
                literal->open_delimiter = literal->close_delimiter = '\n';
                advance(lexer);
            }
            return true;
        }
        default:
            return false;
    }
}

static inline void scan_heredoc_word(TSLexer *lexer, Heredoc *heredoc) {
    String word = array_new();
    int32_t quote = 0;

    switch (lexer->lookahead) {
        case '\'':
        case '"':
        case '`':
            quote = lexer->lookahead;
            advance(lexer);
            while (lexer->lookahead != quote && !lexer->eof(lexer)) {
                append_heredoc_character(&word, lexer->lookahead);
                advance(lexer);
            }
            advance(lexer);
            break;

        default:
            if (is_heredoc_word_character(lexer->lookahead)) {
                append_heredoc_character(&word, lexer->lookahead);
                advance(lexer);
                while (is_heredoc_word_character(lexer->lookahead)) {
                    append_heredoc_character(&word, lexer->lookahead);
                    advance(lexer);
                }
            }
            break;
    }

    heredoc->word = word;
    heredoc->allows_interpolation = quote != '\'';
}

static inline bool scan_short_interpolation(TSLexer *lexer, const bool has_content, const TSSymbol content_symbol) {
    int32_t start = lexer->lookahead;
    if (start == '@' || start == '$') {
        if (has_content) {
            lexer->result_symbol = content_symbol;
            return true;
        }
        lexer->mark_end(lexer);
        advance(lexer);
        bool is_short_interpolation = false;
        if (start == '$') {
            // `strchr` would match the terminator for a NUL lookahead and truncate non-ASCII ones.
            if (lexer->lookahead > 0 && lexer->lookahead < 0x80 &&
                strchr("!@&`'+~=/\\,;.<>*$?:\"", (char)lexer->lookahead) != NULL) {
                is_short_interpolation = true;
            } else {
                if (lexer->lookahead == '-') {
                    advance(lexer);
                    is_short_interpolation = lexer->lookahead >= 0x80 || iswalpha(lexer->lookahead) || lexer->lookahead == '_';
                } else {
                    is_short_interpolation = lexer->lookahead >= 0x80 || iswalnum(lexer->lookahead) || lexer->lookahead == '_';
                }
            }
        }
        if (start == '@') {
            if (lexer->lookahead == '@') {
                advance(lexer);
            }
            is_short_interpolation = is_iden_char(lexer->lookahead) && !iswdigit(lexer->lookahead);
        }

        if (is_short_interpolation) {
            lexer->result_symbol = SHORT_INTERPOLATION;
            return true;
        }
    }
    return false;
}

static inline bool scan_heredoc_content(Scanner *scanner, TSLexer *lexer) {
    Heredoc *heredoc = array_get(&scanner->open_heredocs, 0);
    size_t position_in_word = 0;
    bool look_for_heredoc_end = true;
    bool has_content = false;

    for (;;) {
        if (position_in_word == heredoc->word.size) {
            if (!has_content) {
                lexer->mark_end(lexer);
            }
            bool crossed_range_boundary = lexer->is_at_included_range_start(lexer);
            while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
                advance(lexer);
                crossed_range_boundary |= lexer->is_at_included_range_start(lexer);
            }
            if (lexer->lookahead == '\n' || lexer->lookahead == '\r') {
                if (has_content) {
                    lexer->result_symbol = HEREDOC_CONTENT;
                } else {
                    finish_heredoc(scanner, lexer, !crossed_range_boundary);
                }
                return true;
            }
            has_content = true;
            position_in_word = 0;
        }

        if (lexer->eof(lexer)) {
            lexer->mark_end(lexer);
            if (has_content) {
                lexer->result_symbol = HEREDOC_CONTENT;
            } else {
                finish_heredoc(scanner, lexer, false);
            }
            return true;
        }

        char utf8[4];
        uint32_t utf8_length = encode_utf8(lexer->lookahead, utf8);
        if (look_for_heredoc_end && position_in_word + utf8_length <= heredoc->word.size &&
            memcmp(&heredoc->word.contents[position_in_word], utf8, utf8_length) == 0) {
            advance(lexer);
            position_in_word += utf8_length;
        } else {
            position_in_word = 0;
            look_for_heredoc_end = false;

            if (heredoc->allows_interpolation && lexer->lookahead == '\\') {
                if (has_content) {
                    lexer->result_symbol = HEREDOC_CONTENT;
                    return true;
                }
                return false;
            }

            if (heredoc->allows_interpolation && lexer->lookahead == '#') {
                lexer->mark_end(lexer);
                advance(lexer);
                if (lexer->lookahead == '{') {
                    if (has_content) {
                        lexer->result_symbol = HEREDOC_CONTENT;
                        return true;
                    }
                    return false;
                }
                if (scan_short_interpolation(lexer, has_content, HEREDOC_CONTENT)) {
                    return true;
                }
            } else if (lexer->lookahead == '\r' || lexer->lookahead == '\n') {
                if (lexer->lookahead == '\r') {
                    advance(lexer);
                    if (lexer->lookahead == '\n') {
                        advance(lexer);
                    }
                } else {
                    advance(lexer);
                }
                has_content = true;
                look_for_heredoc_end = true;
                while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
                    advance(lexer);
                    if (!heredoc->end_word_indentation_allowed) {
                        look_for_heredoc_end = false;
                    }
                }
                lexer->mark_end(lexer);
            } else {
                has_content = true;
                advance(lexer);
                lexer->mark_end(lexer);
            }
        }
    }
}

static inline bool scan_literal_content(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    Literal *literal = array_back(&scanner->literal_stack);
    bool has_content = false;
    bool stop_on_space = literal->type == SYMBOL_ARRAY_START || literal->type == STRING_ARRAY_START;
    bool pending_heredoc = has_pending_heredoc_body(scanner, valid_symbols);

    if (literal->resume_after_heredoc && scanner->open_heredocs.size == 0) {
        return scan_literal_resume(literal, lexer, valid_symbols);
    }

    for (;;) {
        if (pending_heredoc && stop_on_space && !has_content && lexer->lookahead != literal->close_delimiter &&
            is_horizontal_whitespace(lexer->lookahead)) {
            return scan_heredoc_after_literal_space(scanner, lexer);
        }
        if (pending_heredoc &&
            (literal->resume_after_heredoc ||
             (literal->close_delimiter != '\n' && lexer->lookahead != literal->close_delimiter)) &&
            (lexer->lookahead == '\n' || lexer->lookahead == '\r')) {
            lexer->mark_end(lexer);
            if (has_content) {
                lexer->result_symbol = STRING_CONTENT;
                return true;
            }
            TSLexerPosition body_start;
            lexer->get_position(lexer, &body_start);
            if (lexer->lookahead == '\r') {
                advance(lexer);
                if (lexer->lookahead != '\n' || lexer->is_at_included_range_start(lexer)) {
                    return finish_literal_content(lexer);
                }
            }
            lexer->mark_start(lexer, &body_start);
            lexer->mark_end_at(lexer, &body_start);
            return start_literal_heredoc_body(scanner, lexer);
        }
        if (stop_on_space && iswspace(lexer->lookahead)) {
            if (has_content) {
                return finish_literal_content(lexer);
            }
            return false;
        }
        if (literal->close_delimiter == '\n' && lexer->lookahead == '\r') {
            TSLexerPosition closing_start;
            lexer->get_position(lexer, &closing_start);
            advance(lexer);
            if (lexer->lookahead != '\n' || lexer->is_at_included_range_start(lexer)) {
                has_content = true;
                continue;
            }
            if (has_content) {
                lexer->mark_end_at(lexer, &closing_start);
                lexer->result_symbol = STRING_CONTENT;
                return true;
            }
        }
        if (lexer->lookahead == literal->close_delimiter) {
            lexer->mark_end(lexer);
            if (literal->nesting_depth == 1) {
                if (has_content) {
                    lexer->result_symbol = STRING_CONTENT;
                } else {
                    bool newline_consumed = pending_heredoc && literal->close_delimiter == '\n';
                    advance(lexer);
                    if (literal->type == REGEX_START && !newline_consumed) {
                        while (iswlower(lexer->lookahead)) {
                            advance(lexer);
                        }
                    }
                    array_pop(&scanner->literal_stack);
                    if (newline_consumed) array_get(&scanner->open_heredocs, 0)->newline_consumed = true;
                    lexer->result_symbol = STRING_END;
                    lexer->mark_end(lexer);
                }
                return true;
            }
            literal->nesting_depth--;
            advance(lexer);

        } else if (lexer->lookahead == literal->open_delimiter) {
            literal->nesting_depth++;
            advance(lexer);
        } else if (literal->allows_interpolation && lexer->lookahead == '#') {
            lexer->mark_end(lexer);
            advance(lexer);
            if (lexer->lookahead == '{') {
                if (has_content) {
                    lexer->result_symbol = STRING_CONTENT;
                    return true;
                }
                return false;
            }
            if (scan_short_interpolation(lexer, has_content, STRING_CONTENT)) {
                return true;
            }
        } else if (lexer->lookahead == '\\') {
            if (has_content && (literal->allows_interpolation || pending_heredoc)) {
                return finish_literal_content(lexer);
            }
            if (pending_heredoc) {
                return scan_heredoc_after_literal_escape(scanner, lexer, !literal->allows_interpolation);
            }
            if (literal->allows_interpolation) return false;
            advance(lexer);
            advance(lexer);

        } else if (lexer->eof(lexer)) {
            advance(lexer);
            lexer->mark_end(lexer);
            return false;
        } else {
            advance(lexer);
        }

        has_content = true;
    }
}

static inline bool scan(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    bool raw_data = valid_symbols[UNINTERPRETED] && !valid_symbols[STRING_START];
    if (raw_data && scanner->open_heredocs.size == 0 && scanner->literal_stack.size == 0) {
        return false;
    }
    scanner->has_leading_whitespace = false;

    if (scanner->open_heredocs.size > 0 && array_get(&scanner->open_heredocs, 0)->finished) {
        return scan_heredoc_host_resume(scanner, lexer, valid_symbols);
    }

    if (has_pending_heredoc_body(scanner, valid_symbols) &&
        (array_get(&scanner->open_heredocs, 0)->newline_consumed ||
         (!lexer->is_at_included_range_start(lexer) && lexer->get_column(lexer) == 0))) {
        mark_current_heredoc_position(lexer);
        return start_heredoc_body(scanner, lexer);
    }

    if (!valid_symbols[STRING_START]) {
        if ((valid_symbols[STRING_CONTENT] || valid_symbols[STRING_END]) && scanner->literal_stack.size > 0) {
            return scan_literal_content(scanner, lexer, valid_symbols);
        }
        if ((valid_symbols[HEREDOC_CONTENT] || valid_symbols[HEREDOC_BODY_END]) && scanner->open_heredocs.size > 0) {
            return scan_heredoc_content(scanner, lexer);
        }
    }

    lexer->result_symbol = NONE;
    bool rescue_may_end_line = false;
    if (!scan_whitespace(scanner, lexer, valid_symbols, &rescue_may_end_line)) {
        return false;
    }
    if (lexer->result_symbol != NONE) {
        return true;
    }

    switch (lexer->lookahead) {
        case '#':
            if (!raw_data && valid_symbols[LINE_COMMENT] && scan_line_comment(lexer)) {
                lexer->mark_end(lexer);
                lexer->result_symbol = LINE_COMMENT;
                return true;
            }
            return false;

        case '{':
            // During error recovery every symbol is valid, STRING_CONTENT included.
            if (valid_symbols[LAMBDA_BRACE] && !valid_symbols[STRING_CONTENT]) {
                advance(lexer);
                lexer->result_symbol = LAMBDA_BRACE;
                return true;
            }
            return false;

        case '=':
            // A regex token cannot require whitespace or EOF after `=end`, so it would end an unterminated comment at
            // the `=end` prefix of a line such as `=endx`.
            if (!raw_data && valid_symbols[BLOCK_COMMENT] && lexer->get_column(lexer) == 0 && scan_embdoc(lexer)) {
                lexer->mark_end(lexer);
                lexer->result_symbol = BLOCK_COMMENT;
                return true;
            }
            return false;

        case '&':
            if (valid_symbols[BLOCK_AMPERSAND] || valid_symbols[BITWISE_AND]) {
                advance(lexer);
                if (lexer->lookahead != '&' && lexer->lookahead != '.' && lexer->lookahead != '=') {
                    if (valid_symbols[BLOCK_AMPERSAND] &&
                        (!valid_symbols[BITWISE_AND] ||
                         (scanner->has_leading_whitespace && !iswspace(lexer->lookahead)))) {
                        lexer->result_symbol = BLOCK_AMPERSAND;
                        return true;
                    }
                    if (valid_symbols[BITWISE_AND]) {
                        lexer->result_symbol = BITWISE_AND;
                        return true;
                    }
                }
                return false;
            }
            break;

        case '<':
            if (valid_symbols[SINGLETON_CLASS_LEFT_ANGLE_LEFT_ANGLE]) {
                advance(lexer);
                if (lexer->lookahead == '<') {
                    advance(lexer);
                    lexer->result_symbol = SINGLETON_CLASS_LEFT_ANGLE_LEFT_ANGLE;
                    return true;
                }
                return false;
            }
            break;

        case '*':
            if (valid_symbols[SPLAT_STAR] || valid_symbols[BINARY_STAR] || valid_symbols[HASH_SPLAT_STAR_STAR] ||
                valid_symbols[BINARY_STAR_STAR]) {
                return scan_splat(scanner, lexer, valid_symbols);
            }
            break;

        case '+':
            if (valid_symbols[UNARY_PLUS]) {
                advance(lexer);
                if (lexer->lookahead == '=') {
                    return false;
                }
                lexer->result_symbol = (!valid_symbols[BINARY_PLUS] ||
                     (scanner->has_leading_whitespace && !iswspace(lexer->lookahead)))
                    ? UNARY_PLUS : BINARY_PLUS;
                return true;
            }
            break;

        case '-':
            if (valid_symbols[UNARY_MINUS] || valid_symbols[UNARY_MINUS_NUM] || valid_symbols[BINARY_MINUS]) {
                advance(lexer);
                if (lexer->lookahead != '=' && lexer->lookahead != '>') {
                    if (valid_symbols[UNARY_MINUS_NUM] &&
                        (!valid_symbols[BINARY_STAR] || scanner->has_leading_whitespace) &&
                        iswdigit(lexer->lookahead)) {
                        lexer->result_symbol = UNARY_MINUS_NUM;
                        return true;
                    }
                    if (valid_symbols[UNARY_MINUS] && scanner->has_leading_whitespace && !iswspace(lexer->lookahead)) {
                        lexer->result_symbol = UNARY_MINUS;
                    } else if (valid_symbols[BINARY_MINUS]) {
                        lexer->result_symbol = BINARY_MINUS;
                    } else {
                        lexer->result_symbol = UNARY_MINUS;
                    }
                    return true;
                }
                return false;
            }
            break;

        case ':':
            if (valid_symbols[SYMBOL_START]) {
                Literal literal = {0};
                literal.type = SYMBOL_START;
                literal.nesting_depth = 1;
                advance(lexer);

                switch (lexer->lookahead) {
                    case '"':
                        advance(lexer);
                        literal.open_delimiter = '"';
                        literal.close_delimiter = '"';
                        literal.allows_interpolation = true;
                        array_push(&scanner->literal_stack, literal);
                        lexer->result_symbol = SYMBOL_START;
                        return true;

                    case '\'':
                        advance(lexer);
                        literal.open_delimiter = '\'';
                        literal.close_delimiter = '\'';
                        literal.allows_interpolation = false;
                        array_push(&scanner->literal_stack, literal);
                        lexer->result_symbol = SYMBOL_START;
                        return true;

                    default:
                        if (scan_symbol_identifier(lexer)) {
                            lexer->result_symbol = SIMPLE_SYMBOL;
                            return true;
                        }
                }

                return false;
            }
            break;

        case '[':
            // Treat a square bracket as an element reference if either:
            // * the bracket is not preceded by any whitespace
            // * an arbitrary expression is not valid at the current position.
            if (valid_symbols[ELEMENT_REFERENCE_BRACKET] &&
                (!scanner->has_leading_whitespace || !valid_symbols[STRING_START])) {
                advance(lexer);
                lexer->result_symbol = ELEMENT_REFERENCE_BRACKET;
                return true;
            }
            break;

        default:
            break;
    }

    if (((valid_symbols[HASH_KEY_SYMBOL] || valid_symbols[IDENTIFIER_SUFFIX]) &&
         (iswalpha(lexer->lookahead) || lexer->lookahead == '_')) ||
        (valid_symbols[CONSTANT_SUFFIX] && iswupper(lexer->lookahead)) ||
        (valid_symbols[NOT_PARENTHESIZED] && lexer->lookahead == 'n')) {
        return scan_word_token(lexer, valid_symbols, rescue_may_end_line);
    }

    if (valid_symbols[STRING_START] || (lexer->lookahead == '%' && valid_symbols[MODULO_ASSIGNMENT])) {
        Literal literal = {0};
        literal.nesting_depth = 1;

        if (lexer->lookahead == '<') {
            // After an operand, `<<` is a shift unless it starts a command argument (`foo <<EOS`). Without whitespace,
            // it still starts the argument of `return`, `break`, or `next`, whose states, unlike those after a name or a
            // call, admit no operator assignment.
            if (valid_symbols[BINARY_STAR] && !expects_operand_across_line_break(valid_symbols) &&
                (!valid_symbols[SPLAT_STAR] || (!scanner->has_leading_whitespace && valid_symbols[MODULO_ASSIGNMENT]))) {
                return false;
            }
            advance(lexer);
            if (lexer->lookahead != '<') {
                return false;
            }
            advance(lexer);

            Heredoc heredoc = {0};
            if (lexer->lookahead == '-' || lexer->lookahead == '~') {
                advance(lexer);
                heredoc.end_word_indentation_allowed = true;
            }

            scan_heredoc_word(lexer, &heredoc);
            if (heredoc.word.size == 0) {
                array_delete(&heredoc.word);
                return false;
            }
            array_push(&scanner->open_heredocs, heredoc);
            lexer->result_symbol = HEREDOC_START;
            return true;
        }

        if (scan_literal_start_or_assignment(scanner, lexer, &literal, valid_symbols)) {
            if (literal.type != MODULO_ASSIGNMENT) {
                if (literal.close_delimiter == '\n' && has_pending_heredoc_body(scanner, valid_symbols)) {
                    array_get(&scanner->open_heredocs, 0)->newline_consumed = true;
                    literal.resume_after_heredoc = true;
                }
                array_push(&scanner->literal_stack, literal);
            }
            lexer->result_symbol = literal.type;
            return true;
        }
        return false;
    }

    return false;
}

static bool scan_splat(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    TokenType binary = BINARY_STAR;
    TokenType splat = SPLAT_STAR;
    advance(lexer);
    if (lexer->lookahead == '*') {
        binary = BINARY_STAR_STAR;
        splat = HASH_SPLAT_STAR_STAR;
        if (!valid_symbols[binary] && !valid_symbols[splat]) return false;
        advance(lexer);
    }
    if (lexer->lookahead == '=') return false;
    bool prefer_binary = !scanner->has_leading_whitespace || iswspace(lexer->lookahead) || !valid_symbols[splat];
    TokenType result = valid_symbols[binary] && prefer_binary ? binary : splat;
    if (!valid_symbols[result]) return false;
    lexer->result_symbol = result;
    return true;
}

static bool scan_word_token(TSLexer *lexer, const bool *valid_symbols, bool rescue_may_end_line) {
    static const char RESCUE[] = "rescue";
    TokenType suffix = iswupper(lexer->lookahead) ? CONSTANT_SUFFIX : IDENTIFIER_SUFFIX;
    bool not_word = valid_symbols[NOT_PARENTHESIZED];
    unsigned length = 0;
    lexer->mark_end(lexer);
    while (iswalnum(lexer->lookahead) || lexer->lookahead == '_') {
        not_word &= length < 3 && lexer->lookahead == "not"[length];
        rescue_may_end_line &= length < sizeof(RESCUE) - 1 && lexer->lookahead == RESCUE[length];
        length++;
        advance(lexer);
    }
    if (rescue_may_end_line && length == sizeof(RESCUE) - 1 && ends_keyword(lexer->lookahead)) {
        // A zero-width line break ends the hash shorthand or range before the `rescue` clause, which may name a
        // top-level constant (`rescue::Foo`). A `rescue:` hash key cannot follow a hash shorthand without a comma.
        if (lexer->lookahead == ':') {
            advance(lexer);
            if (lexer->lookahead != ':') return false;
        }
        lexer->result_symbol = LINE_BREAK;
        return true;
    }
    if (valid_symbols[HASH_KEY_SYMBOL] && lexer->lookahead == ':') {
        lexer->mark_end(lexer);
        advance(lexer);
        if (lexer->lookahead != ':') {
            lexer->result_symbol = HASH_KEY_SYMBOL;
            return true;
        }
    } else if (valid_symbols[suffix] && lexer->lookahead == '!') {
        advance(lexer);
        lexer->mark_end(lexer);
        if (lexer->lookahead != '=') {
            lexer->result_symbol = suffix;
            return true;
        }
    }
    if (!not_word || length != 3) return false;
    lexer->mark_end(lexer);
    if (!scan_not_parentheses_gap(lexer)) return false;
    lexer->result_symbol = NOT_PARENTHESIZED;
    return true;
}

static bool scan_not_parentheses_gap(TSLexer *lexer) {
    bool separated = false;
    bool line_break = false;
    for (;;) {
        if (iswspace(lexer->lookahead)) {
            separated = true;
            line_break |= lexer->lookahead == '\n';
            advance(lexer);
            continue;
        }
        switch (lexer->lookahead) {
            case '\\':
                separated = true;
                advance(lexer);
                if (lexer->lookahead == '\r') advance(lexer);
                if (lexer->lookahead != '\n') return false;
                advance(lexer);
                break;
            case '#':
                separated = true;
                scan_line_comment(lexer);
                break;
            case '=':
                if (!line_break || lexer->get_column(lexer) != 0 || !scan_embdoc(lexer)) return false;
                separated = true;
                break;
            default:
                return lexer->lookahead == '(' && (!separated || line_break);
        }
    }
}

static bool scan_embdoc(TSLexer *lexer) {
    if (!scan_word_text(lexer, "=begin") || !iswspace(lexer->lookahead)) return false;
    while (!lexer->eof(lexer)) {
        bool closed = lexer->get_column(lexer) == 0 && lexer->lookahead == '=' &&
                      scan_word_text(lexer, "=end") && (iswspace(lexer->lookahead) || lexer->eof(lexer));
        while (!lexer->eof(lexer) && lexer->lookahead != '\n') advance(lexer);
        if (closed) return true;
        if (!lexer->eof(lexer)) advance(lexer);
    }
    return false;
}

static inline bool scan_literal_resume(Literal *literal, TSLexer *lexer, const bool *valid_symbols) {
    if (!valid_symbols[HEREDOC_RESUME] || (lexer->lookahead != '\r' && lexer->lookahead != '\n')) return false;
    bool carriage_return = lexer->lookahead == '\r';
    advance(lexer);
    if (carriage_return && lexer->lookahead == '\n' && !lexer->is_at_included_range_start(lexer)) advance(lexer);
    literal->resume_after_heredoc = false;
    lexer->result_symbol = HEREDOC_RESUME;
    lexer->mark_end(lexer);
    return true;
}

static inline bool scan_heredoc_host_resume(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    if (!valid_symbols[HEREDOC_RESUME]) return false;
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') advance(lexer);
    if (lexer->lookahead == '\r') {
        advance(lexer);
        if (lexer->is_at_included_range_start(lexer)) return false;
    }
    if (lexer->lookahead != '\n') return false;
    advance(lexer);
    Heredoc *heredoc = array_get(&scanner->open_heredocs, 0);
    array_delete(&heredoc->word);
    array_erase(&scanner->open_heredocs, 0);
    lexer->result_symbol = HEREDOC_RESUME;
    lexer->mark_end(lexer);
    return true;
}

static inline void finish_heredoc(Scanner *scanner, TSLexer *lexer, bool can_resume) {
    Heredoc *heredoc = array_get(&scanner->open_heredocs, 0);
    bool resume_host = heredoc->host_line_continued && scanner->open_heredocs.size == 1 && can_resume;
    if (resume_host && lexer->lookahead == '\r') {
        advance(lexer);
        resume_host = lexer->lookahead == '\n' && !lexer->is_at_included_range_start(lexer);
    }
    if (resume_host) {
        heredoc->finished = true;
    } else {
        if (heredoc->host_line_continued && scanner->open_heredocs.size > 1) {
            array_get(&scanner->open_heredocs, 1)->host_line_continued = true;
        }
        array_delete(&heredoc->word);
        array_erase(&scanner->open_heredocs, 0);
    }
    lexer->result_symbol = HEREDOC_BODY_END;
}

static inline bool has_pending_heredoc_body(Scanner *scanner, const bool *valid_symbols) {
    return valid_symbols[HEREDOC_BODY_START] && scanner->open_heredocs.size > 0 &&
           !array_get(&scanner->open_heredocs, 0)->started;
}

static inline bool scan_heredoc_after_literal_escape(Scanner *scanner, TSLexer *lexer, bool consume_plain_escape) {
    advance(lexer);
    bool separated = lexer->is_at_included_range_start(lexer);
    if (separated && (lexer->lookahead == '\r' || lexer->lookahead == '\n')) {
        return finish_literal_content(lexer);
    }
    if (separated && !consume_plain_escape) return false;
    bool carriage_return = !separated && lexer->lookahead == '\r';
    if (carriage_return) {
        advance(lexer);
        if (lexer->is_at_included_range_start(lexer)) return finish_literal_content(lexer);
    }
    if (!separated && lexer->lookahead == '\n') {
        advance(lexer);
        mark_current_heredoc_position(lexer);
        return start_literal_heredoc_body(scanner, lexer);
    }
    if (!consume_plain_escape) return false;
    if (!carriage_return) advance(lexer);
    return finish_literal_content(lexer);
}

static inline bool finish_literal_content(TSLexer *lexer) {
    lexer->mark_end(lexer);
    lexer->result_symbol = STRING_CONTENT;
    return true;
}

static inline bool scan_heredoc_after_literal_space(Scanner *scanner, TSLexer *lexer) {
    TSLexerPosition body_start;
    bool after_carriage_return = false;
    do {
        after_carriage_return = lexer->lookahead == '\r';
        if (after_carriage_return) lexer->get_position(lexer, &body_start);
        lexer->advance(lexer, true);
        if (lexer->is_at_included_range_start(lexer)) after_carriage_return = false;
    } while (is_horizontal_whitespace(lexer->lookahead));
    if (lexer->lookahead == '\\') {
        return scan_heredoc_after_literal_escape(scanner, lexer, false);
    }
    if (lexer->lookahead != '\n') {
        return false;
    }
    if (!after_carriage_return) lexer->get_position(lexer, &body_start);
    lexer->mark_start(lexer, &body_start);
    lexer->mark_end_at(lexer, &body_start);
    return start_literal_heredoc_body(scanner, lexer);
}

static inline bool is_horizontal_whitespace(int32_t codepoint) {
    return codepoint == ' ' || codepoint == '\t' || codepoint == '\f' || codepoint == '\v' || codepoint == '\r';
}

static inline bool start_literal_heredoc_body(Scanner *scanner, TSLexer *lexer) {
    Literal *literal = array_back(&scanner->literal_stack);
    if (literal->close_delimiter == '\n') literal->resume_after_heredoc = true;
    return start_heredoc_body(scanner, lexer);
}

static inline bool start_heredoc_body(Scanner *scanner, TSLexer *lexer) {
    Heredoc *heredoc = array_get(&scanner->open_heredocs, 0);
    heredoc->started = true;
    heredoc->newline_consumed = false;
    lexer->result_symbol = HEREDOC_BODY_START;
    return true;
}

static inline void mark_current_heredoc_position(TSLexer *lexer) {
    TSLexerPosition body_start;
    lexer->get_position(lexer, &body_start);
    lexer->mark_start(lexer, &body_start);
    lexer->mark_end_at(lexer, &body_start);
}

static inline bool is_heredoc_word_character(int32_t codepoint) {
    return codepoint >= 0x80 || iswalnum(codepoint) || codepoint == '_';
}

static inline void append_heredoc_character(String *word, int32_t codepoint) {
    char utf8[4];
    uint32_t length = encode_utf8(codepoint, utf8);
    array_extend(word, length, utf8);
}

static inline uint32_t encode_utf8(int32_t codepoint, char *bytes) {
    if (codepoint < 0x80) {
        bytes[0] = (char)codepoint;
        return 1;
    }
    uint32_t length = codepoint < 0x800 ? 2 : codepoint < 0x10000 ? 3 : 4;
    for (uint32_t index = length - 1; index > 0; index--) {
        bytes[index] = (char)(0x80 | (codepoint & 0x3F));
        codepoint >>= 6;
    }
    bytes[0] = (char)((0xF00 >> length) | codepoint);
    return length;
}

static bool scan_word_text(TSLexer *lexer, const char *word) {
    for (; *word; word++) {
        if (lexer->lookahead != *word) return false;
        advance(lexer);
    }
    return true;
}

static inline bool scan_line_comment(TSLexer *lexer) {
    advance(lexer);
    while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
        if (lexer->is_at_included_range_start(lexer)) {
            return true;
        }
        advance(lexer);
    }
    return false;
}

void *tree_sitter_ruby_external_scanner_create() {
    Scanner *scanner = (Scanner *)ts_calloc(1, sizeof(Scanner));
    return scanner;
}

bool tree_sitter_ruby_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
    Scanner *scanner = (Scanner *)payload;
    return scan(scanner, lexer, valid_symbols);
}

unsigned tree_sitter_ruby_external_scanner_serialize(void *payload, char *buffer) {
    Scanner *scanner = (Scanner *)payload;
    return serialize(scanner, buffer);
}

void tree_sitter_ruby_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
    Scanner *scanner = (Scanner *)payload;
    deserialize(scanner, buffer, length);
}

void tree_sitter_ruby_external_scanner_destroy(void *payload) {
    Scanner *scanner = (Scanner *)payload;
    for (uint32_t i = 0; i < scanner->open_heredocs.size; i++) {
        array_delete(&array_get(&scanner->open_heredocs, i)->word);
    }
    array_delete(&scanner->open_heredocs);
    array_delete(&scanner->literal_stack);
    ts_free(scanner);
}
