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
    JUMP_OPERAND,

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
    BODY_COMMENT,
    BODY_LINE_BREAK,
    END_OF_SOURCE,

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
    Literal literal;
    uint32_t parent;
    uint32_t depth;
} LiteralFrame;

typedef struct {
    uint32_t words[7];
} LiteralKey;

typedef struct {
    uint32_t children[2];
    uint32_t frame;
    uint8_t bit;
} LiteralIndexNode;

typedef struct {
    String word;
    bool end_word_indentation_allowed;
    bool squiggly;
    bool allows_interpolation;
    bool mid_line;
    bool started;
    bool newline_consumed;
    bool host_line_continued;
    bool finished;
} Heredoc;

typedef struct {
    bool has_leading_whitespace;
    bool continuation_comments;
    Array(LiteralFrame) literal_frames;
    Array(LiteralIndexNode) literal_index;
    uint32_t literal_root;
    Literal literal;
    uint32_t literal_parent;
    uint32_t literal_depth;
    Array(Heredoc) open_heredocs;
} Scanner;

typedef enum {
    HEREDOC_SCAN_CONTINUE,
    HEREDOC_SCAN_TOKEN,
    HEREDOC_SCAN_DEFER,
} HeredocScanResult;

const char NON_IDENTIFIER_CHARS[] = {
    '\0', '\n', '\r', '\t', ' ', ':', ';', '`',  '"', '\'', '@', '$', '#', '.', ',', '|', '^', '&',
    '<',  '=',  '>',  '+',  '-', '*', '/', '\\', '%', '?',  '!', '~', '(', ')', '[', ']', '{', '}',
};

static inline void skip(Scanner *scanner, TSLexer *lexer) {
    scanner->has_leading_whitespace = true;
    lexer->advance(lexer, true);
}

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }

static inline void scan_symbol_suffix(TSLexer *lexer);
static inline bool scan_global_symbol(TSLexer *lexer);
static inline bool scan_symbol_word(TSLexer *lexer);
static inline bool is_symbol_word_character(int32_t character);
static inline bool is_symbol_word_start(int32_t character);

static uint32_t save_literal(Scanner *scanner);
static void restore_literal(Scanner *scanner, uint32_t frame_id);
static LiteralKey literal_key(const LiteralFrame *frame);
static uint8_t literal_difference(LiteralKey left, LiteralKey right);
static unsigned literal_bit(LiteralKey key, uint8_t bit);

static inline void reset(Scanner *scanner) {
    scanner->continuation_comments = 0;
    restore_literal(scanner, 0);
    for (uint32_t i = 0; i < scanner->open_heredocs.size; i++) {
        array_delete(&array_get(&scanner->open_heredocs, i)->word);
    }
    array_delete(&scanner->open_heredocs);
}

static inline unsigned serialize(Scanner *scanner, char *buffer) {
    unsigned size = 0;

    bool has_literal = scanner->literal_depth > 0;
    buffer[size++] = (char)(has_literal | (scanner->continuation_comments << 1));
    if (has_literal) {
        uint32_t frame_id = save_literal(scanner);
        memcpy(&buffer[size], &frame_id, sizeof(frame_id));
        size += sizeof(frame_id);
    }

    buffer[size++] = (char)scanner->open_heredocs.size;
    for (uint32_t i = 0; i < scanner->open_heredocs.size; i++) {
        Heredoc *heredoc = array_get(&scanner->open_heredocs, i);
        if (heredoc->word.size > (UINT16_MAX >> 4) ||
            size + 4 + heredoc->word.size > TREE_SITTER_SERIALIZATION_BUFFER_SIZE) {
            return 0;
        }
        buffer[size++] = (char)(heredoc->end_word_indentation_allowed | (heredoc->squiggly << 1));
        buffer[size++] = (char)(heredoc->allows_interpolation | (heredoc->mid_line << 1));
        buffer[size++] = (char)(((heredoc->word.size >> 8) << 4) | (heredoc->finished << 3) | (heredoc->host_line_continued << 2) | (heredoc->newline_consumed << 1) | heredoc->started);
        buffer[size++] = (char)(heredoc->word.size & 0xFF);
        memcpy(&buffer[size], heredoc->word.contents, heredoc->word.size);
        size += heredoc->word.size;
    }

    return size;
}

// code-gauge-allow functionNcss 35 -- The header and pending heredoc records decode one layout; splitting it would duplicate buffer-position bookkeeping.
static inline void deserialize(Scanner *scanner, const char *buffer, unsigned length) {
    unsigned size = 0;
    scanner->has_leading_whitespace = false;
    reset(scanner);

    if (length == 0) {
        return;
    }

    uint8_t flags = buffer[size++];
    scanner->continuation_comments = (flags & 2) != 0;
    if (flags & 1) {
        uint32_t frame_id;
        memcpy(&frame_id, &buffer[size], sizeof(frame_id));
        size += sizeof(frame_id);
        restore_literal(scanner, frame_id);
    }

    uint8_t open_heredoc_count = buffer[size++];
    for (unsigned j = 0; j < open_heredoc_count; j++) {
        Heredoc heredoc = {0};
        uint8_t indentation_flags = (uint8_t)buffer[size++];
        heredoc.end_word_indentation_allowed = (indentation_flags & 1) != 0;
        heredoc.squiggly = (indentation_flags & 2) != 0;
        uint8_t interpolation_flags = (uint8_t)buffer[size++];
        heredoc.allows_interpolation = (interpolation_flags & 1) != 0;
        heredoc.mid_line = (interpolation_flags & 2) != 0;
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

static void push_literal(Scanner *scanner, Literal literal) {
    scanner->literal_parent = scanner->literal_depth ? save_literal(scanner) : 0;
    scanner->literal = literal;
    scanner->literal_depth++;
}

static void pop_literal(Scanner *scanner) {
    restore_literal(scanner, scanner->literal_parent);
}

// The runtime gives each full parse its own scanner. Keep immutable parent frames until destruction so parser
// branches can restore arbitrary literal depths through frame IDs without copying or truncating the whole stack.
// code-gauge-allow functionNcss 42 -- Lookup and insertion share the canonical trie; splitting them would relocate index traversal and node ownership bookkeeping.
static uint32_t save_literal(Scanner *scanner) {
    LiteralFrame frame = {scanner->literal, scanner->literal_parent, scanner->literal_depth};
    LiteralKey key = literal_key(&frame);
    uint32_t current = scanner->literal_root;
    while (current && !scanner->literal_index.contents[current - 1].frame) {
        const LiteralIndexNode *node = &scanner->literal_index.contents[current - 1];
        current = node->children[literal_bit(key, node->bit)];
    }
    uint8_t difference = 0;
    if (current) {
        uint32_t existing = scanner->literal_index.contents[current - 1].frame;
        difference = literal_difference(key, literal_key(&scanner->literal_frames.contents[existing - 1]));
        if (difference == UINT8_MAX) return existing;
    }
    array_push(&scanner->literal_frames, frame);
    uint32_t frame_id = scanner->literal_frames.size;
    LiteralIndexNode leaf = {{0, 0}, frame_id, 0};
    array_push(&scanner->literal_index, leaf);
    uint32_t inserted = scanner->literal_index.size;
    if (!current) {
        scanner->literal_root = inserted;
        return frame_id;
    }
    uint32_t parent = 0;
    unsigned direction = 0;
    current = scanner->literal_root;
    while (!scanner->literal_index.contents[current - 1].frame &&
           scanner->literal_index.contents[current - 1].bit < difference) {
        parent = current;
        const LiteralIndexNode *node = &scanner->literal_index.contents[current - 1];
        direction = literal_bit(key, node->bit);
        current = node->children[direction];
    }
    LiteralIndexNode branch = {{0, 0}, 0, difference};
    direction = literal_bit(key, difference);
    branch.children[direction] = inserted;
    branch.children[!direction] = current;
    array_push(&scanner->literal_index, branch);
    inserted = scanner->literal_index.size;
    if (parent) {
        const LiteralIndexNode *node = &scanner->literal_index.contents[parent - 1];
        direction = literal_bit(key, node->bit);
        scanner->literal_index.contents[parent - 1].children[direction] = inserted;
    } else {
        scanner->literal_root = inserted;
    }
    return frame_id;
}

static void restore_literal(Scanner *scanner, uint32_t frame_id) {
    assert(frame_id <= scanner->literal_frames.size);
    if (frame_id == 0) {
        scanner->literal = (Literal){0};
        scanner->literal_parent = 0;
        scanner->literal_depth = 0;
        return;
    }
    const LiteralFrame *frame = array_get(&scanner->literal_frames, frame_id - 1);
    scanner->literal = frame->literal;
    scanner->literal_parent = frame->parent;
    scanner->literal_depth = frame->depth;
}

// Equal stacks need equal serialized IDs for the runtime to join parser branches. The fixed-width radix key
// bounds lookup and insertion by 224 bits, independently of literal depth or the number of saved frames.
static LiteralKey literal_key(const LiteralFrame *frame) {
    const Literal *literal = &frame->literal;
    return (LiteralKey){{frame->parent, frame->depth, (uint32_t)literal->type,
        (uint32_t)literal->open_delimiter, (uint32_t)literal->close_delimiter,
        (uint32_t)literal->nesting_depth, literal->allows_interpolation | (literal->resume_after_heredoc << 1)}};
}

static uint8_t literal_difference(LiteralKey left, LiteralKey right) {
    for (uint8_t word = 0; word < 7; word++) {
        uint32_t difference = left.words[word] ^ right.words[word];
        if (!difference) continue;
        uint8_t bit = 0;
        while (!(difference & 1)) {
            difference >>= 1;
            bit++;
        }
        return word * 32 + bit;
    }
    return UINT8_MAX;
}

static unsigned literal_bit(LiteralKey key, uint8_t bit) {
    return (key.words[bit / 32] >> (bit % 32)) & 1;
}

static inline bool scan_literal_resume(Literal *literal, TSLexer *lexer, const bool *valid_symbols);
static inline bool scan_heredoc_host_resume(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols);
static inline void finish_heredoc(Scanner *scanner, TSLexer *lexer, bool can_resume, uint32_t index);
static inline uint32_t first_started_heredoc_index(Scanner *scanner);
static inline bool has_pending_heredoc_body(Scanner *scanner, const bool *valid_symbols);
static inline bool scan_heredoc_after_literal_escape(Scanner *scanner, TSLexer *lexer, bool consume_plain_escape);
static inline bool finish_literal_content(TSLexer *lexer);
static inline bool scan_heredoc_after_literal_space(Scanner *scanner, TSLexer *lexer);
static inline bool is_horizontal_whitespace(int32_t codepoint);
static inline bool start_literal_heredoc_body(Scanner *scanner, TSLexer *lexer);
static inline bool start_heredoc_body(Scanner *scanner, TSLexer *lexer);
static inline bool is_short_interpolation_name_start(int32_t prefix, int32_t codepoint);
static inline bool heredoc_word_starts_interpolation(const Heredoc *heredoc);
static inline bool scan_heredoc_end_word(Heredoc *heredoc, TSLexer *lexer);
static bool scan_heredoc_prefix_token(Heredoc *heredoc, TSLexer *lexer, size_t matched);
static HeredocScanResult scan_heredoc_line_prefix(Scanner *scanner, TSLexer *lexer, uint32_t current, bool *has_content);
static HeredocScanResult scan_heredoc_interpolation(Heredoc *heredoc, TSLexer *lexer, bool *has_content);
static inline bool finish_heredoc_at_line_end(Scanner *scanner, TSLexer *lexer, bool has_content, uint32_t index);
static inline bool advance_heredoc_line(Heredoc *heredoc, TSLexer *lexer);
static inline void mark_current_heredoc_position(TSLexer *lexer);
static inline bool is_heredoc_word_character(int32_t codepoint);
static inline uint32_t encode_utf8(int32_t codepoint, char *bytes);
static inline void append_heredoc_character(String *word, int32_t codepoint);
static inline bool scan_line_comment(TSLexer *lexer);
static bool scan_comment_line_break(Scanner *scanner, TSLexer *lexer);
static bool scan_after_whitespace(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols, bool crossed_newline, bool crossed_line);
static bool scan_continuation_comment(Scanner *scanner, TSLexer *lexer);
static bool scan_splat(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols);
static bool scan_word_token(TSLexer *lexer, const bool *valid_symbols, bool rescue_may_end_line);
static bool scan_not_parentheses_gap(TSLexer *lexer);
static bool scan_embdoc(TSLexer *lexer);
static bool scan_word_text(TSLexer *lexer, const char *word);
static bool scan_leading_logical_operator(TSLexer *lexer);
static bool scan_line_break(TSLexer *lexer);
static bool scan_host_line_escape(Scanner *scanner, TSLexer *lexer, bool heredoc_body_start_is_valid);
static bool scan_end_marker_line_end(TSLexer *lexer);

static inline bool scan_whitespace(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols,
                                   bool *rescue_may_end_line) {
    bool heredoc_body_start_is_valid = has_pending_heredoc_body(scanner, valid_symbols);
    bool crossed_newline = false;
    bool crossed_line = lexer->is_at_included_range_start(lexer);
    bool line_break_valid = valid_symbols[LINE_BREAK] || valid_symbols[BODY_LINE_BREAK];

    for (;;) {
        if (!valid_symbols[NO_LINE_BREAK] && line_break_valid && lexer->is_at_included_range_start(lexer)) {
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
                crossed_line = true;
                if (heredoc_body_start_is_valid) {
                    return start_heredoc_body(scanner, lexer);
                } else if (!valid_symbols[NO_LINE_BREAK] && line_break_valid && !crossed_newline) {
                    lexer->mark_end(lexer);
                    // Keep the saved LINE_BREAK endpoint, but exclude this newline from a following external token.
                    lexer->advance(lexer, true);
                    crossed_newline = true;
                } else {
                    // After a hash shorthand (`foo key:`) or `..`, the operand may follow on the next line unless that
                    // line starts a `rescue` clause.
                    *rescue_may_end_line = valid_symbols[NO_LINE_BREAK] && line_break_valid;
                    skip(scanner, lexer);
                }
                break;
            case '\\':
                if (!scan_host_line_escape(scanner, lexer, heredoc_body_start_is_valid)) return false;
                if (lexer->result_symbol == HEREDOC_BODY_START) return true;
                break;
            default:
                return scan_after_whitespace(scanner, lexer, valid_symbols, crossed_newline, crossed_line);
        }
    }
}

static bool scan_after_whitespace(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols,
                                  bool crossed_newline, bool crossed_line) {
    if (lexer->lookahead == '#') {
        if (scanner->continuation_comments) return scan_continuation_comment(scanner, lexer);
        if (crossed_newline && (valid_symbols[BODY_LINE_BREAK] || valid_symbols[BODY_COMMENT])) {
            return scan_comment_line_break(scanner, lexer);
        }
        if (crossed_newline) return true;
        if (crossed_line && valid_symbols[BODY_COMMENT]) {
            scan_line_comment(lexer);
            lexer->mark_end(lexer);
            lexer->result_symbol = BODY_COMMENT;
            return true;
        }
    } else if (crossed_line && valid_symbols[BODY_COMMENT] && lexer->lookahead == '=' &&
               lexer->get_column(lexer) == 0 && scan_embdoc(lexer)) {
        lexer->mark_end(lexer);
        lexer->result_symbol = BODY_COMMENT;
        return true;
    }
    return !crossed_newline || scan_line_break(lexer);
}

static bool scan_continuation_comment(Scanner *scanner, TSLexer *lexer) {
    bool range_boundary = scan_line_comment(lexer);
    TSLexerCheckpoint comment_end;
    lexer->get_checkpoint(lexer, &comment_end);
    while (!range_boundary && iswspace(lexer->lookahead) && !lexer->is_at_included_range_start(lexer)) advance(lexer);
    scanner->continuation_comments = !range_boundary && !lexer->is_at_included_range_start(lexer) && lexer->lookahead == '#';
    lexer->mark_end_at(lexer, &comment_end);
    lexer->result_symbol = LINE_COMMENT;
    return true;
}

static bool scan_line_break(TSLexer *lexer) {
    switch (lexer->lookahead) {
        case '|':
        case 'a':
        case 'o':
            if (scan_leading_logical_operator(lexer)) return false;
            break;
        case '.':
            advance(lexer);
            if (lexer->eof(lexer) || lexer->lookahead != '.') return false;
            break;
        case '&':
        case '#':
            return true;
    }
    lexer->result_symbol = LINE_BREAK;
    return true;
}

static bool scan_comment_line_break(Scanner *scanner, TSLexer *lexer) {
    TSLexerCheckpoint comment_start;
    TSLexerCheckpoint comment_end;
    lexer->get_checkpoint(lexer, &comment_start);
    uint32_t comment_count = 0;
    do {
        bool range_boundary = scan_line_comment(lexer);
        if (comment_count++ == 0) lexer->get_checkpoint(lexer, &comment_end);
        if (range_boundary) break;
        while (iswspace(lexer->lookahead) && !lexer->is_at_included_range_start(lexer)) advance(lexer);
    } while (lexer->lookahead == '#' && !lexer->is_at_included_range_start(lexer));

    bool continued = !lexer->is_at_included_range_start(lexer) &&
                     (!scan_line_break(lexer) || lexer->result_symbol != LINE_BREAK);
    if (continued) {
        scanner->continuation_comments = comment_count > 1;
        lexer->mark_start(lexer, &comment_start);
        lexer->mark_end_at(lexer, &comment_end);
        lexer->result_symbol = LINE_COMMENT;
    } else {
        lexer->result_symbol = LINE_BREAK;
    }
    return true;
}

static bool scan_host_line_escape(Scanner *scanner, TSLexer *lexer, bool heredoc_body_start_is_valid) {
    advance(lexer);
    if (heredoc_body_start_is_valid && lexer->is_at_included_range_start(lexer)) return false;
    if (lexer->lookahead == '\r') {
        skip(scanner, lexer);
        if (heredoc_body_start_is_valid && lexer->is_at_included_range_start(lexer)) return false;
    }
    if (!iswspace(lexer->lookahead)) return false;
    bool starts_body = heredoc_body_start_is_valid && lexer->lookahead == '\n';
    skip(scanner, lexer);
    if (!starts_body) return true;
    array_get(&scanner->open_heredocs, 0)->host_line_continued = true;
    mark_current_heredoc_position(lexer);
    return start_heredoc_body(scanner, lexer);
}

static bool scan_leading_logical_operator(TSLexer *lexer) {
    if (lexer->lookahead == '|') {
        advance(lexer);
        return lexer->lookahead == '|';
    }
    if (!scan_word_text(lexer, lexer->lookahead == 'a' ? "and" : "or")) return false;
    return lexer->lookahead < 0x80 && !iswalnum(lexer->lookahead) && lexer->lookahead != '_' &&
        lexer->lookahead != '?' && lexer->lookahead != '!';
}

static inline bool scan_operator(TSLexer *lexer) {
    static const struct {
        const char *name;
        bool allowed;
    } operators[] = {
        {"|", true}, {"^", true}, {"&", true}, {"<=>", true}, {"==", true},
        {"===", true}, {"=~", true}, {">", true}, {">=", true}, {"<", true},
        {"<=", true}, {"+", true}, {"!=", true}, {"-", true}, {"*", true},
        {"/", true}, {"%", true}, {"!", true}, {"!@", true}, {"!~", true},
        {"**", true}, {"<<", true}, {">>", true}, {"~", true}, {"+@", true},
        {"-@", true}, {"~@", true}, {"[]", true}, {"`", true}, {"[]=", true},
        {"|=", false}, {"^=", false}, {"&=", false}, {"*=", false}, {"/=", false},
        {"%=", false}, {"**=", false}, {"<<=", false}, {">>=", false}, {"&&", false},
        {"||", false},
    };
    char prefix[3];
    bool complete = false;
    for (unsigned length = 0; length < sizeof(prefix); length++) {
        if (lexer->lookahead <= 0 || lexer->lookahead > 0x7f) return complete;
        prefix[length] = (char)lexer->lookahead;
        bool found = false;
        bool next_complete = false;
        for (unsigned index = 0; index < sizeof(operators) / sizeof(operators[0]); index++) {
            if (strncmp(operators[index].name, prefix, length + 1) == 0) {
                found = true;
                next_complete |= operators[index].allowed && operators[index].name[length + 1] == '\0';
            }
        }
        if (!found) return complete;
        advance(lexer);
        complete = next_complete;
        if (complete) lexer->mark_end(lexer);
    }
    return complete;
}

static inline bool is_iden_char(int32_t c) {
    return c > 0x7f || memchr(&NON_IDENTIFIER_CHARS, c, sizeof(NON_IDENTIFIER_CHARS)) == NULL;
}

// Whether `c` ends a keyword instead of extending it into a name or a method name.
static inline bool ends_keyword(int32_t c) { return !is_iden_char(c) && c != '?' && c != '!'; }

static inline bool scan_symbol_identifier(TSLexer *lexer) {
    if (lexer->lookahead == '$') return scan_global_symbol(lexer);
    if (lexer->lookahead == '@') {
        advance(lexer);
        if (lexer->lookahead == '@') advance(lexer);
        return scan_symbol_word(lexer);
    }
    if (!is_symbol_word_start(lexer->lookahead)) return scan_operator(lexer);
    scan_symbol_word(lexer);
    lexer->mark_end(lexer);
    if (lexer->lookahead == '!' || lexer->lookahead == '?' || lexer->lookahead == '=') {
        scan_symbol_suffix(lexer);
    }
    return true;
}

static inline void scan_symbol_suffix(TSLexer *lexer) {
    int32_t suffix = lexer->lookahead;
    advance(lexer);
    if (suffix != '=') {
        if (lexer->lookahead != '=') lexer->mark_end(lexer);
    } else if (lexer->lookahead == '=') {
        TSLexerCheckpoint setter_end;
        lexer->get_checkpoint(lexer, &setter_end);
        advance(lexer);
        if (lexer->lookahead == '>') lexer->mark_end_at(lexer, &setter_end);
    } else if (lexer->lookahead != '>' && lexer->lookahead != '~') {
        lexer->mark_end(lexer);
    }
}

static inline bool scan_global_symbol(TSLexer *lexer) {
    advance(lexer);
    if (lexer->lookahead == '-') {
        advance(lexer);
        if (!is_symbol_word_character(lexer->lookahead)) return false;
        advance(lexer);
        return true;
    }
    if (lexer->lookahead >= '0' && lexer->lookahead <= '9') {
        bool zero = lexer->lookahead == '0';
        advance(lexer);
        if (!zero) {
            while (lexer->lookahead >= '0' && lexer->lookahead <= '9') advance(lexer);
        }
        return true;
    }
    if (lexer->lookahead > 0 && lexer->lookahead < 0x80 && strchr("!@&`'+~=/\\,;.<>*$?:\"", lexer->lookahead)) {
        advance(lexer);
        return true;
    }
    return scan_symbol_word(lexer);
}

static inline bool scan_symbol_word(TSLexer *lexer) {
    if (!is_symbol_word_start(lexer->lookahead)) return false;
    do {
        advance(lexer);
    } while (is_symbol_word_character(lexer->lookahead));
    return true;
}

static inline bool is_symbol_word_character(int32_t character) {
    return is_symbol_word_start(character) || (character >= '0' && character <= '9');
}

static inline bool is_symbol_word_start(int32_t character) {
    return character > 0x7f || character == '_' || (character >= 'a' && character <= 'z') ||
        (character >= 'A' && character <= 'Z');
}

// NO_LINE_BREAK is valid after `..` and `...` (an endless range) and after a hash shorthand (`foo key:`), where Ruby
// reads an operand on the same or the next line although binary operators are valid because the expression may
// already be complete. JUMP_OPERAND marks the same-line operand after return, break, and next without suppressing
// their terminating newline. STRING_CONTENT is valid along with STRING_START only in error recovery.
static inline bool expects_literal_operand(const bool *valid_symbols) {
    return (valid_symbols[NO_LINE_BREAK] || valid_symbols[JUMP_OPERAND]) && !valid_symbols[STRING_CONTENT];
}

static bool skip_spaced_percent_literal(Scanner *scanner, TSLexer *lexer, const Literal *literal);
static bool starts_symbol_operand(TSLexer *lexer);
static inline bool suspends_for_heredoc(Scanner *scanner, TSLexer *lexer);
static bool scan_command_continuation_keyword(TSLexer *lexer);

static inline bool is_spaced_percent_delimiter(int32_t delimiter) {
    return delimiter == ' ' || delimiter == '\t' || delimiter == '\r';
}

// Returns 0 when `delimiter` cannot open a percent literal. After a name, `foo %q abc ` is a command argument,
// whereas `foo %q\n` stays modulo: Ruby chooses between them by whether `foo` is a local variable, which the scanner
// cannot see, and a literal would swallow the following line.
static inline int32_t percent_close_delimiter(int32_t delimiter, bool binary_operator_valid, bool spaced_literal_prefix) {
    switch (delimiter) {
        case '(':
            return ')';
        case '[':
            return ']';
        case '{':
            return '}';
        case '<':
            return '>';
        case '\n':
            return binary_operator_valid ? 0 : delimiter;
        case '\r':
        case ' ':
        case '\t':
            return binary_operator_valid && !spaced_literal_prefix ? 0 : delimiter;
        default:
            // strchr would also match the terminating NUL (end of input) and truncate wide characters.
            return delimiter > 0 && delimiter < 128 && strchr("|!#/\\@$%^&*)]}>=+-~`,.?:;_\"'", delimiter) ? delimiter
                                                                                                       : 0;
    }
}

// After a name, `sink %q abc , 1` passes a literal argument, whereas `left %q + 1` divides by `q` when `left` is a
// local variable. The scanner cannot see local variables, so it keeps the literal unless the text after it starts
// another operand, which no command argument can be followed by.
static bool spaced_percent_literal_ends_argument(Scanner *scanner, TSLexer *lexer, const Literal *literal) {
    if (!is_spaced_percent_delimiter(literal->close_delimiter)) return true;
    lexer->mark_end(lexer);
    if (!skip_spaced_percent_literal(scanner, lexer, literal)) return true;
    if (literal->type == REGEX_START) {
        // Ruby reads every following letter as a regex option and rejects unknown ones.
        while (is_symbol_word_character(lexer->lookahead)) {
            if (lexer->lookahead > 0x7f || !strchr("eimnosux", (char)lexer->lookahead)) return false;
            advance(lexer);
        }
    }
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') advance(lexer);
    if (is_symbol_word_character(lexer->lookahead)) return scan_command_continuation_keyword(lexer);
    return !starts_symbol_operand(lexer);
}

// Covers the non-word operand starts; `[`, `-`, `::`, and quotes can continue a literal argument.
static bool starts_symbol_operand(TSLexer *lexer) {
    switch (lexer->lookahead) {
        case '@':
        case '$':
        case '(':
        case '~':
            return true;
        case '!':
            advance(lexer);
            return lexer->lookahead != '=' && lexer->lookahead != '~';
        case ':':
            advance(lexer);
            return lexer->lookahead != ':' && !iswspace(lexer->lookahead) && !lexer->eof(lexer);
        default:
            return false;
    }
}

// Returns false where the literal's extent cannot be read from raw text: at an interpolation or a braced Unicode
// escape (`\u{41 42}`), whose contents may contain the delimiter, and at a line break while a heredoc body is
// queued, which the literal suspends for.
static bool skip_spaced_percent_literal(Scanner *scanner, TSLexer *lexer, const Literal *literal) {
    while (lexer->lookahead != literal->close_delimiter) {
        if (lexer->eof(lexer) || suspends_for_heredoc(scanner, lexer)) return false;
        int32_t character = lexer->lookahead;
        advance(lexer);
        if (character == '\\') {
            if (suspends_for_heredoc(scanner, lexer)) return false;
            bool unicode = literal->allows_interpolation && lexer->lookahead == 'u';
            advance(lexer);
            if (unicode && lexer->lookahead == '{') return false;
        }
        if (character == '#' && literal->allows_interpolation && lexer->lookahead == '{') return false;
    }
    advance(lexer);
    return true;
}

static inline bool suspends_for_heredoc(Scanner *scanner, TSLexer *lexer) {
    return scanner->open_heredocs.size > 0 && (lexer->lookahead == '\n' || lexer->lookahead == '\r');
}

static bool scan_command_continuation_keyword(TSLexer *lexer) {
    static const char *const keywords[] = {"and", "do",   "else",   "elsif", "end",  "ensure", "if",   "in",
                                           "or",  "rescue", "then", "unless", "until", "when", "while"};
    char word[7] = {0};
    for (unsigned length = 0; is_symbol_word_character(lexer->lookahead); length++) {
        if (length == sizeof(word) - 1 || lexer->lookahead > 0x7f) return false;
        word[length] = (char)lexer->lookahead;
        advance(lexer);
    }
    // `if!` and `end?` are method names.
    if (lexer->lookahead == '!' || lexer->lookahead == '?') {
        advance(lexer);
        if (lexer->lookahead != '=') return false;
    }
    for (unsigned i = 0; i < sizeof(keywords) / sizeof(keywords[0]); i++) {
        if (strcmp(word, keywords[i]) == 0) return true;
    }
    return false;
}

static inline bool scan_literal_start_or_assignment(Scanner *scanner, TSLexer *lexer, Literal *literal, const bool *valid_symbols) {
    const bool binary_operator_valid =
        valid_symbols[FORWARD_SLASH] && !expects_literal_operand(valid_symbols);

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
            bool spaced_literal_prefix = false;
            for (unsigned i = 0; i < sizeof(kinds) / sizeof(kinds[0]); i++) {
                if (lexer->lookahead == kinds[i].prefix) {
                    literal->type = kinds[i].type;
                    literal->allows_interpolation = kinds[i].allows_interpolation;
                    // Ruby rejects whitespace-delimited word and symbol lists, so only other kinds may follow a name.
                    spaced_literal_prefix = kinds[i].type != STRING_ARRAY_START && kinds[i].type != SYMBOL_ARRAY_START;
                    advance(lexer);
                    break;
                }
            }
            TokenType required_token = literal->type == SYMBOL_START ? SIMPLE_SYMBOL : literal->type;
            if (!valid_symbols[required_token]) {
                return false;
            }

            literal->open_delimiter = lexer->lookahead;
            literal->close_delimiter = percent_close_delimiter(
                lexer->lookahead, binary_operator_valid, spaced_literal_prefix && scanner->has_leading_whitespace);
            if (literal->close_delimiter == 0) {
                return false;
            }

            advance(lexer);
            if (literal->close_delimiter == '\r' && lexer->lookahead == '\n' &&
                !lexer->is_at_included_range_start(lexer)) {
                if (binary_operator_valid || (valid_symbols[JUMP_OPERAND] && literal->type == REGEX_START)) return false;
                literal->open_delimiter = literal->close_delimiter = '\n';
                advance(lexer);
            }
            return !binary_operator_valid || spaced_percent_literal_ends_argument(scanner, lexer, literal);
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
        if (start == '@' && lexer->lookahead == '@') advance(lexer);
        if (start == '$' && lexer->lookahead == '-') {
            start = '-';
            advance(lexer);
        }
        bool is_short_interpolation = is_short_interpolation_name_start(start, lexer->lookahead);

        if (is_short_interpolation) {
            lexer->result_symbol = SHORT_INTERPOLATION;
            return true;
        }
    }
    return false;
}

static inline bool scan_heredoc_content(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    uint32_t current = first_started_heredoc_index(scanner);
    if (current == scanner->open_heredocs.size) current = 0;
    Heredoc *heredoc = array_get(&scanner->open_heredocs, current);
    bool look_for_heredoc_end = !heredoc->mid_line ||
        (!heredoc->squiggly && heredoc_word_starts_interpolation(heredoc) && lexer->get_column(lexer) == 0);
    bool has_content = false;

    for (;;) {
        if (look_for_heredoc_end) {
            HeredocScanResult result = scan_heredoc_line_prefix(scanner, lexer, current, &has_content);
            if (result != HEREDOC_SCAN_CONTINUE) return result == HEREDOC_SCAN_TOKEN;
            look_for_heredoc_end = false;
        }
        if (lexer->eof(lexer)) {
            lexer->mark_end(lexer);
            if (has_content) lexer->result_symbol = HEREDOC_CONTENT;
            else finish_heredoc(scanner, lexer, false, current);
            return true;
        }
        if (heredoc->allows_interpolation && (lexer->lookahead == '#' || lexer->lookahead == '\\')) {
            HeredocScanResult result = scan_heredoc_interpolation(heredoc, lexer, &has_content);
            if (result != HEREDOC_SCAN_CONTINUE) return result == HEREDOC_SCAN_TOKEN;
            continue;
        }
        bool line_end = lexer->lookahead == '\r' || lexer->lookahead == '\n';
        if (line_end && current > 0 && valid_symbols[HEREDOC_BODY_START]) {
            lexer->result_symbol = HEREDOC_CONTENT;
            return has_content || start_heredoc_body(scanner, lexer);
        }
        if (line_end) {
            look_for_heredoc_end = advance_heredoc_line(heredoc, lexer);
        } else {
            advance(lexer);
            lexer->mark_end(lexer);
        }
        has_content = true;
    }
}

static HeredocScanResult scan_heredoc_line_prefix(Scanner *scanner, TSLexer *lexer, uint32_t current, bool *has_content) {
    Heredoc *heredoc = array_get(&scanner->open_heredocs, current);
    size_t matched = 0;
    TSLexerCheckpoint interpolation_start;
    TSLexerCheckpoint interior_token_start;
    bool has_interior_token = false;
    while (matched < heredoc->word.size && !lexer->eof(lexer)) {
        if (!has_interior_token && matched > 0 && heredoc->allows_interpolation &&
            (lexer->lookahead == '#' || lexer->lookahead == '\\')) {
            lexer->get_checkpoint(lexer, &interior_token_start);
            has_interior_token = true;
        }
        char utf8[4];
        uint32_t length = encode_utf8(lexer->lookahead, utf8);
        if (matched + length > heredoc->word.size ||
            memcmp(&heredoc->word.contents[matched], utf8, length) != 0) break;
        advance(lexer);
        matched += length;
        if (matched == 1 && heredoc->word.contents[0] == '#') lexer->get_checkpoint(lexer, &interpolation_start);
    }
    if (matched == heredoc->word.size) {
        if (!*has_content) lexer->mark_end(lexer);
        if (finish_heredoc_at_line_end(scanner, lexer, *has_content, current)) return HEREDOC_SCAN_TOKEN;
    }
    if (scan_heredoc_prefix_token(heredoc, lexer, matched)) {
        heredoc->mid_line = true;
        if (*has_content) {
            lexer->result_symbol = HEREDOC_CONTENT;
            return HEREDOC_SCAN_TOKEN;
        }
        if (lexer->result_symbol != SHORT_INTERPOLATION) return HEREDOC_SCAN_DEFER;
        lexer->mark_end_at(lexer, &interpolation_start);
        return HEREDOC_SCAN_TOKEN;
    }
    if (has_interior_token) {
        heredoc->mid_line = true;
        lexer->mark_end_at(lexer, &interior_token_start);
        lexer->result_symbol = HEREDOC_CONTENT;
        return HEREDOC_SCAN_TOKEN;
    }
    if (matched > 0) {
        *has_content = true;
        lexer->mark_end(lexer);
    }
    return HEREDOC_SCAN_CONTINUE;
}

static bool scan_heredoc_prefix_token(Heredoc *heredoc, TSLexer *lexer, size_t matched) {
    if (!heredoc->allows_interpolation || matched == 0) return false;
    if (heredoc->word.contents[0] == '\\') {
        lexer->result_symbol = NONE;
        return true;
    }
    if (heredoc->word.contents[0] != '#') return false;
    int32_t prefix = matched > 1 ? (unsigned char)heredoc->word.contents[1] : lexer->lookahead;
    if (prefix == '{') {
        lexer->result_symbol = NONE;
        return true;
    }
    if (prefix != '@' && prefix != '$') return false;
    if (matched == 1) advance(lexer);
    int32_t character = matched > 2 ? (unsigned char)heredoc->word.contents[2] : lexer->lookahead;
    bool extended = (prefix == '@' && character == '@') || (prefix == '$' && character == '-');
    if (extended && matched <= 2) advance(lexer);
    if (extended && prefix == '$') prefix = '-';
    size_t name_position = extended ? 3 : 2;
    character = matched > name_position ? (unsigned char)heredoc->word.contents[name_position] : lexer->lookahead;
    if (!is_short_interpolation_name_start(prefix, character)) return false;
    lexer->result_symbol = SHORT_INTERPOLATION;
    return true;
}

static HeredocScanResult scan_heredoc_interpolation(Heredoc *heredoc, TSLexer *lexer, bool *has_content) {
    if (lexer->lookahead == '\\') {
        if (!*has_content) return HEREDOC_SCAN_DEFER;
        heredoc->mid_line = true;
        lexer->result_symbol = HEREDOC_CONTENT;
        return HEREDOC_SCAN_TOKEN;
    }
    lexer->mark_end(lexer);
    advance(lexer);
    if (lexer->lookahead == '{') {
        if (!*has_content) return HEREDOC_SCAN_DEFER;
        heredoc->mid_line = true;
        lexer->result_symbol = HEREDOC_CONTENT;
        return HEREDOC_SCAN_TOKEN;
    }
    heredoc->mid_line = true;
    if (scan_short_interpolation(lexer, *has_content, HEREDOC_CONTENT)) return HEREDOC_SCAN_TOKEN;
    *has_content = true;
    lexer->mark_end(lexer);
    return HEREDOC_SCAN_CONTINUE;
}

static inline bool finish_heredoc_at_line_end(Scanner *scanner, TSLexer *lexer, bool has_content, uint32_t index) {
    if (lexer->lookahead != '\n' && lexer->lookahead != '\r' && !lexer->eof(lexer)) return false;
    if (has_content) {
        array_get(&scanner->open_heredocs, index)->mid_line = false;
        lexer->result_symbol = HEREDOC_CONTENT;
    } else {
        finish_heredoc(scanner, lexer, !lexer->is_at_included_range_start(lexer), index);
    }
    return true;
}

static inline bool advance_heredoc_line(Heredoc *heredoc, TSLexer *lexer) {
    bool carriage_return = lexer->lookahead == '\r';
    advance(lexer);
    if (carriage_return && lexer->lookahead == '\n') advance(lexer);
    bool at_line_start = true;
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
        advance(lexer);
        at_line_start = heredoc->end_word_indentation_allowed;
    }
    lexer->mark_end(lexer);
    return at_line_start;
}

static inline bool heredoc_word_starts_interpolation(const Heredoc *heredoc) {
    if (heredoc->word.size < 2 || heredoc->word.contents[0] != '#') return false;
    const unsigned char *word = (const unsigned char *)heredoc->word.contents;
    if (word[1] == '{') return true;
    int32_t prefix = word[1];
    if (prefix != '@' && prefix != '$') return false;
    size_t index = 2;
    if (index < heredoc->word.size && prefix == '@' && word[index] == '@') index++;
    if (index < heredoc->word.size && prefix == '$' && word[index] == '-') {
        prefix = '-';
        index++;
    }
    return index < heredoc->word.size && is_short_interpolation_name_start(prefix, word[index]);
}

static inline bool is_short_interpolation_name_start(int32_t prefix, int32_t codepoint) {
    if (prefix == '@') return is_iden_char(codepoint) && !iswdigit(codepoint);
    if (prefix == '-') return codepoint >= 0x80 || iswalpha(codepoint) || codepoint == '_';
    return codepoint >= 0x80 || iswalnum(codepoint) || codepoint == '_' ||
        (codepoint > 0 && codepoint < 0x80 && strchr("!@&`'+~=/\\,;.<>*$?:\"", (char)codepoint) != NULL);
}

static inline bool scan_literal_content(Scanner *scanner, TSLexer *lexer, const bool *valid_symbols) {
    Literal *literal = &scanner->literal;
    bool has_content = false;
    bool stop_on_space = literal->type == SYMBOL_ARRAY_START || literal->type == STRING_ARRAY_START;
    bool pending_heredoc = has_pending_heredoc_body(scanner, valid_symbols);

    if (literal->resume_after_heredoc &&
        (scanner->open_heredocs.size == 0 || array_get(&scanner->open_heredocs, 0)->started)) {
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
            TSLexerCheckpoint body_start;
            lexer->get_checkpoint(lexer, &body_start);
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
            TSLexerCheckpoint closing_start;
            lexer->get_checkpoint(lexer, &closing_start);
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
                    pop_literal(scanner);
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
    if (raw_data && scanner->open_heredocs.size == 0 && scanner->literal_depth == 0) {
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
        if ((valid_symbols[STRING_CONTENT] || valid_symbols[STRING_END]) && scanner->literal_depth > 0) {
            return scan_literal_content(scanner, lexer, valid_symbols);
        }
        if ((valid_symbols[HEREDOC_CONTENT] || valid_symbols[HEREDOC_BODY_END]) && scanner->open_heredocs.size > 0) {
            return scan_heredoc_content(scanner, lexer, valid_symbols);
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
                        push_literal(scanner, literal);
                        lexer->result_symbol = SYMBOL_START;
                        return true;

                    case '\'':
                        advance(lexer);
                        literal.open_delimiter = '\'';
                        literal.close_delimiter = '\'';
                        literal.allows_interpolation = false;
                        push_literal(scanner, literal);
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
        (valid_symbols[NOT_PARENTHESIZED] && lexer->lookahead == 'n') ||
        (valid_symbols[END_OF_SOURCE] && lexer->lookahead == '_' && lexer->get_column(lexer) == 0)) {
        return scan_word_token(lexer, valid_symbols, rescue_may_end_line);
    }

    if (valid_symbols[STRING_START] || (lexer->lookahead == '%' && valid_symbols[MODULO_ASSIGNMENT])) {
        Literal literal = {0};
        literal.nesting_depth = 1;

        if (lexer->lookahead == '<') {
            // A completed operand needs a separating gap for a heredoc command argument (`foo <<EOS`);
            // explicit operand contexts also allow an adjacent heredoc (`return<<EOS`).
            if (valid_symbols[BINARY_STAR] && !expects_literal_operand(valid_symbols) &&
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
                heredoc.squiggly = lexer->lookahead == '~';
                advance(lexer);
                heredoc.end_word_indentation_allowed = true;
            }

            scan_heredoc_word(lexer, &heredoc);
            if (heredoc.word.size == 0) {
                array_delete(&heredoc.word);
                return false;
            }
            uint32_t index = first_started_heredoc_index(scanner);
            array_insert(&scanner->open_heredocs, index, heredoc);
            lexer->result_symbol = HEREDOC_START;
            return true;
        }

        if (scan_literal_start_or_assignment(scanner, lexer, &literal, valid_symbols)) {
            if (literal.type != MODULO_ASSIGNMENT) {
                if (literal.close_delimiter == '\n' && has_pending_heredoc_body(scanner, valid_symbols)) {
                    array_get(&scanner->open_heredocs, 0)->newline_consumed = true;
                    literal.resume_after_heredoc = true;
                }
                push_literal(scanner, literal);
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

// code-gauge-allow functionCognitiveComplexity 29 -- Suffixes and whole-word tokens share the scan so lookahead cannot consume another token's input.
// code-gauge-allow functionNcss 42 -- Suffixes and whole-word tokens share the scan so lookahead cannot consume another token's input.
static bool scan_word_token(TSLexer *lexer, const bool *valid_symbols, bool rescue_may_end_line) {
    static const char RESCUE[] = "rescue";
    TokenType suffix = iswupper(lexer->lookahead) ? CONSTANT_SUFFIX : IDENTIFIER_SUFFIX;
    bool not_word = valid_symbols[NOT_PARENTHESIZED];
    bool end_marker = valid_symbols[END_OF_SOURCE] && lexer->get_column(lexer) == 0;
    unsigned length = 0;
    lexer->mark_end(lexer);
    while (iswalnum(lexer->lookahead) || lexer->lookahead == '_') {
        not_word &= length < 3 && lexer->lookahead == "not"[length];
        end_marker &= length < 7 && lexer->lookahead == "__END__"[length] &&
            (length == 0 || !lexer->is_at_included_range_start(lexer));
        rescue_may_end_line &= length < sizeof(RESCUE) - 1 && lexer->lookahead == RESCUE[length];
        length++;
        advance(lexer);
    }
    if (end_marker && length == 7 &&
        (lexer->lookahead == '\n' || lexer->lookahead == '\r' || lexer->eof(lexer))) {
        return scan_end_marker_line_end(lexer);
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

static bool scan_end_marker_line_end(TSLexer *lexer) {
    lexer->mark_end(lexer);
    if (lexer->lookahead == '\r') {
        advance(lexer);
        if (lexer->lookahead != '\n') return false;
    }
    lexer->result_symbol = END_OF_SOURCE;
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

static inline void finish_heredoc(Scanner *scanner, TSLexer *lexer, bool can_resume, uint32_t index) {
    Heredoc *heredoc = array_get(&scanner->open_heredocs, index);
    bool has_pending_sibling = index + 1 < scanner->open_heredocs.size &&
                               !array_get(&scanner->open_heredocs, index + 1)->started;
    bool resume_host = heredoc->host_line_continued && index == 0 && !has_pending_sibling && can_resume;
    if (resume_host && lexer->lookahead == '\r') {
        advance(lexer);
        resume_host = lexer->lookahead == '\n' && !lexer->is_at_included_range_start(lexer);
    }
    if (resume_host) {
        heredoc->finished = true;
    } else {
        if (heredoc->host_line_continued && has_pending_sibling) {
            array_get(&scanner->open_heredocs, index + 1)->host_line_continued = true;
        }
        array_delete(&heredoc->word);
        array_erase(&scanner->open_heredocs, index);
    }
    lexer->result_symbol = HEREDOC_BODY_END;
}

static inline uint32_t first_started_heredoc_index(Scanner *scanner) {
    uint32_t index = 0;
    while (index < scanner->open_heredocs.size && !array_get(&scanner->open_heredocs, index)->started) index++;
    return index;
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
    TSLexerCheckpoint body_start;
    bool after_carriage_return = false;
    do {
        after_carriage_return = lexer->lookahead == '\r';
        if (after_carriage_return) lexer->get_checkpoint(lexer, &body_start);
        lexer->advance(lexer, true);
        if (lexer->is_at_included_range_start(lexer)) after_carriage_return = false;
    } while (is_horizontal_whitespace(lexer->lookahead));
    if (lexer->lookahead == '\\') {
        return scan_heredoc_after_literal_escape(scanner, lexer, false);
    }
    if (lexer->lookahead != '\n') {
        return false;
    }
    if (!after_carriage_return) lexer->get_checkpoint(lexer, &body_start);
    lexer->mark_start(lexer, &body_start);
    lexer->mark_end_at(lexer, &body_start);
    return start_literal_heredoc_body(scanner, lexer);
}

static inline bool is_horizontal_whitespace(int32_t codepoint) {
    return codepoint == ' ' || codepoint == '\t' || codepoint == '\f' || codepoint == '\v' || codepoint == '\r';
}

static inline bool start_literal_heredoc_body(Scanner *scanner, TSLexer *lexer) {
    Literal *literal = &scanner->literal;
    if (literal->close_delimiter == '\n') literal->resume_after_heredoc = true;
    return start_heredoc_body(scanner, lexer);
}

static inline bool start_heredoc_body(Scanner *scanner, TSLexer *lexer) {
    Heredoc *heredoc = array_get(&scanner->open_heredocs, 0);
    heredoc->started = true;
    heredoc->newline_consumed = false;
    if (heredoc->allows_interpolation && (lexer->lookahead == '#' || lexer->lookahead == '\\')) {
        lexer->mark_end(lexer);
        heredoc->mid_line = !scan_heredoc_end_word(heredoc, lexer);
    }
    lexer->result_symbol = HEREDOC_BODY_START;
    return true;
}

static inline bool scan_heredoc_end_word(Heredoc *heredoc, TSLexer *lexer) {
    for (size_t position = 0; position < heredoc->word.size;) {
        char utf8[4];
        uint32_t length = encode_utf8(lexer->lookahead, utf8);
        if (position + length > heredoc->word.size ||
            memcmp(&heredoc->word.contents[position], utf8, length) != 0) return false;
        position += length;
        advance(lexer);
    }
    return lexer->lookahead == '\r' || lexer->lookahead == '\n' || lexer->eof(lexer);
}

static inline void mark_current_heredoc_position(TSLexer *lexer) {
    TSLexerCheckpoint body_start;
    lexer->get_checkpoint(lexer, &body_start);
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
    bool scanned = scan(scanner, lexer, valid_symbols);
    if (scanned && lexer->result_symbol == LINE_BREAK && valid_symbols[BODY_LINE_BREAK]) {
        lexer->result_symbol = BODY_LINE_BREAK;
    }
    return scanned;
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
    array_delete(&scanner->literal_frames);
    array_delete(&scanner->literal_index);
    ts_free(scanner);
}
