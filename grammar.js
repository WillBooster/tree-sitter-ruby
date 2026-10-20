/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

const PREC = {
  COMMENT: -2,
  CURLY_BLOCK: 1,
  DO_BLOCK: -1,

  AND: -2,
  OR: -2,
  NOT: 5,
  PATTERN: 6,
  DEFINED: 10,
  ALIAS: 11,
  ASSIGN: 15,
  RESCUE: 16,
  CONDITIONAL: 20,
  RANGE: 25,
  BOOLEAN_OR: 30,
  BOOLEAN_AND: 35,
  RELATIONAL: 40,
  COMPARISON: 45,
  BITWISE_OR: 50,
  BITWISE_AND: 55,
  CALL: 56,
  SHIFT: 60,
  ADDITIVE: 65,
  MULTIPLICATIVE: 70,
  UNARY_MINUS: 75,
  EXPONENTIAL: 80,
  COMPLEMENT: 85,
};

// Regex sources reach src/grammar.json as written, so they keep upstream's spelling, and tree-sitter's regex parser
// rejects an unescaped `[` in a character class.
// oxlint-disable no-control-regex, no-useless-escape, unicorn/no-hex-escape -- See above.
const IDENTIFIER_CHARS = /[^\x00-\x1F\s:;`"'@$#.,|^&<=>+\-*/\\%?!~()\[\]{}]*/;
const LOWER_ALPHA_CHAR = /[^\x00-\x1F\sA-Z0-9:;`"'@$#.,|^&<=>+\-*/\\%?!~()\[\]{}]/;
const ALPHA_CHAR = /[^\x00-\x1F\s0-9:;`"'@$#.,|^&<=>+\-*/\\%?!~()\[\]{}]/;
// oxlint-enable no-control-regex, no-useless-escape, unicorn/no-hex-escape

// oxlint-disable-next-line unicorn/prefer-module -- This package is CommonJS, so tree-sitter loads grammar.js as CommonJS.
module.exports = grammar({
  name: 'ruby',
  inline: ($) => [$._arg_rhs, $._call_operator],
  externals: ($) => [
    $._line_break,
    $._no_line_break,

    // Delimited literals
    $.simple_symbol,
    $._string_start,
    $._symbol_start,
    $._subshell_start,
    $._regex_start,
    $._string_array_start,
    $._symbol_array_start,
    $._heredoc_body_start,
    $.string_content,
    $.heredoc_content,
    $._string_end,
    $.heredoc_end,
    $.heredoc_beginning,

    // Tokens that require lookahead
    '/',
    $._block_ampersand,
    $._splat_star,
    $._unary_plus,
    $._binary_plus,
    $._unary_minus,
    $._unary_minus_num,
    $._binary_minus,
    $._binary_star,
    $._bitwise_and,
    $._singleton_class_left_angle_left_langle,
    $.hash_key_symbol,
    $._identifier_suffix,
    $._constant_suffix,
    $._hash_splat_star_star,
    $._binary_star_star,
    $._modulo_assignment,
    $._element_reference_bracket,
    $._short_interpolation,
    $._line_comment,
    $._block_comment,
    $._uninterpreted,
    $._not_parenthesized,
    $._lambda_brace,
  ],

  extras: ($) => [$.comment, $.heredoc_body, /\s/, /\\\r?\n/],

  word: ($) => $.identifier,

  reserved: { global: () => [], variables: () => ['in', 'ensure', 'rescue', 'else'], methodNames: () => [] },

  conflicts: ($) => [
    [$._command_not_operand_expression, $._chained_test_pattern, $._negated_chained_test_pattern],
    [
      $._command_not_operand_expression,
      $._chained_test_pattern,
      $._negated_chained_test_pattern,
      $._yield_test_pattern,
    ],
    [$._command_value, $._ordinary_rhs_expression],
    [$._command_value, $._yield_value, $._ordinary_rhs_expression],
    [$._expression, $._test_pattern_not_operand_expression, $._yield_pattern_not_operand_expression],
    [$._command_value, $._command_not_operand_expression, $._yield_value],
    [$._yield_value, $._ordinary_rhs_expression],
    [$._yield_argument_expression, $._yield_assignment_rhs],
    [$._command_value, $._test_pattern_not_operand_expression],
    [$._test_pattern_not_operand_expression, $._yield_pattern_not_operand_expression],
    [$._expression, $._yield_pattern_not_operand_expression],
    [$._command_not_operand_expression, $._yield_value],
    [$._command_not_operand_expression, $._chained_match_pattern, $._yield_value],
    [$._command_not_operand_expression, $._pattern_command_operand_expression],
    [$._command_not_operand_expression, $._chained_match_pattern],
    [$._yield_pattern_not_operand_expression, $._yield_value],
    [$._command_value, $._command_not_operand_expression, $._test_pattern_not_operand_expression],
    [$._command_not_operand_expression, $._test_pattern_not_operand_expression],
    [$._non_pattern_expression, $._command_not_operand_expression],
    [$._expression, $._test_pattern_not_operand_expression],
    [$._expression, $._command_not_operand_expression],
    [$._command_value, $._command_not_operand_expression],
    [$._signed_command_argument_list, $._yield_signed_argument_list],
    [$._chained_match_pattern, $._yield_value],
    [$._endless_body_rescue, $._yield_method_body_rescue],
    [$._body_expr, $._yield_method_rest],
    [$._pattern_command_not, $._command_not],
    [$._negated_chained_test_pattern, $._yield_test_pattern],
    [$._chained_test_pattern, $._negated_chained_test_pattern, $._yield_test_pattern, $._command_not],
    [$._chained_test_pattern, $._negated_chained_test_pattern, $._command_not],
    [$._command_not, $._test_pattern_not],
    [$.unary, $._command_not],
    [$._command_value, $._argument_command_value, $._yield_value],
    [$._argument_command_value, $._chained_match_pattern, $._yield_value],
    [$._argument_command_value, $._yield_value, $.pair],
    [$._argument_command_value, $._yield_value],
    [$._argument_command_value, $._command_pair],
    [$._argument_command_value, $.pair],
    [$._argument_command_value, $._command_definition_pair],
    [$._argument_command_value, $._chained_match_pattern],
    [$._argument_command_value, $._chained_test_pattern],
    [$._command_value, $._argument_command_value],
    [$._command_pair_key_arguments, $._yield_command_pair_key_arguments],
    [$._yield_argument_list, $._yield_call_pair_key_arguments],
    [$.command_call, $._command_pair, $._yield_command_pair],
    [$._command_pair, $._yield_command_pair],
    [$._command_value, $._command_pair, $._yield_command_pair],
    [$._pattern_unary, $.unary],
    [$._arg, $._pattern_arg],
    [$._chained_assignment, $._pattern_chained_assignment],
    [$.command_assignment, $._pattern_command_assignment],
    [$.assignment, $._pattern_assignment],
    [$._command_argument, $._yield_call_pair_key_arguments],
    [$._yield_argument, $._yield_call_pair_key_arguments],
    [$._yield_argument, $._command_argument, $._yield_call_pair_key_arguments],
    [$._yield_argument, $._yield_pair_key_arguments],
    [$._yield_pattern_not, $._test_pattern_not],
    [$._yield_argument_list, $._yield_pair_key_arguments],
    [$._body_expr, $._yield_value],
    [$._endless_command_operand, $._yield_value],
    [$._yield_argument, $._command_argument],
    [$._command_value, $._yield_value, $.pair],
    [$._command_value, $._chained_match_pattern, $._yield_value],
    [$._command_value, $._yield_value],
    [$._yield_value, $.pair],
    [$._yield_value, $._yield_command_pair],
    [$._chained_command_argument_list, $.command_argument_list],
    [$._pair_block_argument, $.block_argument],
    [$.command_call_with_block, $._super_command_with_block],
    [$.command_call, $._command_pair],
    [$._command_value, $._command_pair],
    [$._statement, $._chained_test_pattern],
    [$._chained_test_pattern, $.command_call],
    [$._command_value, $._chained_test_pattern],
    [$._non_pattern_expression, $._chained_test_pattern],
    [$._chained_primary, $._chained_lhs],
    [$._command_value, $.pair],
    [$._command_value, $._command_definition_pair],
    [$._chained_match_pattern, $.command_call],
    [$.call, $._variable],
    [$._primary, $.call],
    [$._primary, $._variable],
    [$._primary, $.command_call_with_block, $._variable],
    [$._primary, $._super_command, $.command_call_with_block, $._variable],
    [$._non_pattern_expression, $._chained_match_pattern],
    [$._command_value, $._chained_match_pattern],
    [$._array_pattern_n, $.as_pattern, $._find_pattern_body],
  ],

  supertypes: ($) => [
    $._statement,
    $._argument_expression,
    $._command_value_expression,
    $._ordinary_rhs_expression,
    $._yield_assignment_rhs,
    $._command_not_operand_expression,
    $._yield_not_operand_expression,
    $._test_pattern_not_operand_expression,
    $._yield_pattern_not_operand_expression,
    $._pattern_command_operand_expression,
    $._command_argument_expression,
    $._yield_argument_expression,
    $._value_argument_expression,
    $._pattern_arg,
    $._arg,
    $._method_name,
    $._expression,
    $._variable,
    $._primary,
    $._simple_numeric,
    $._lhs,
    $._nonlocal_variable,
    $._pattern_top_expr_body,
    $._pattern_expr,
    $._pattern_expr_basic,
    $._pattern_primitive,
    $._pattern_constant,
  ],

  rules: {
    program: ($) => seq(optional($._statements), optional(choice(seq(/__END__/, $.uninterpreted)))),

    // External extras must yield to the internal lexer after __END__.
    uninterpreted: ($) => choice(/(.|\s)*/, $._uninterpreted),

    block_body: ($) => $._statements,

    _statements: ($) =>
      choice(
        seq(repeat1(choice(seq($._statement, $._terminator), $.empty_statement)), optional($._statement)),
        $._statement
      ),

    begin_block: ($) => seq('BEGIN', '{', optional($._statements), '}'),
    end_block: ($) => seq('END', '{', optional($._statements), '}'),

    _statement: ($) =>
      choice(
        $.undef,
        $.alias,
        $.if_modifier,
        $.unless_modifier,
        $.while_modifier,
        $.until_modifier,
        $.rescue_modifier,
        $.begin_block,
        $.end_block,
        $._expression
      ),

    method: ($) => seq('def', $._method_rest),

    singleton_method: ($) => singletonMethod($, $._method_rest),

    _method_rest: ($) => methodRest($, $._body_expr),

    rescue_modifier_arg: ($) => prec(PREC.RESCUE, seq(field('body', $._arg), 'rescue', field('handler', $._arg))),

    _command_value_rescue: ($) =>
      prec(
        PREC.RESCUE,
        seq(field('body', alias($._command_value_expression, $._expression)), 'rescue', field('handler', $._arg))
      ),

    rescue_modifier_expression: ($) =>
      prec(PREC.RESCUE, seq(field('body', $._non_pattern_expression), 'rescue', field('handler', $._arg))),

    _body_expr: ($) => seq('=', field('body', endlessBody($, $._arg, $._endless_body_rescue))),

    _endless_body_rescue: ($) => endlessBodyRescue($, $._arg),

    _command_method: ($) => seq('def', $._command_method_rest),

    _command_singleton_method: ($) => singletonMethod($, $._command_method_rest),

    _command_method_rest: ($) => endlessMethodRest($, $._endless_command),

    // Ruby 4.0's default parser (Prism) lets an endless body hold at most one `rescue`, applied outside any `not`; a
    // further `rescue` applies to the whole definition.
    _endless_command: ($) => choice($._endless_command_operand, alias($._endless_command_rescue, $.rescue_modifier)),

    _endless_command_operand: ($) =>
      choice(
        alias($.command_call, $.call),
        alias($.command_call_with_block, $.call),
        $._chained_arg,
        alias($._chained_assignment, $.assignment),
        alias($._chained_operator_assignment, $.operator_assignment),
        alias($.return_command, $.return),
        alias($.yield_command, $.yield),
        alias($._endless_command_not, $.unary),
        alias($._command_method, $.method),
        alias($._command_singleton_method, $.singleton_method)
      ),

    _endless_command_not: ($) =>
      choice($._test_pattern_not, prec.right(PREC.NOT, seq(field('operator', 'not'), field('operand', $._expression)))),

    _endless_command_rescue: ($) =>
      prec(PREC.RESCUE, seq(field('body', $._endless_command_operand), 'rescue', field('handler', $._arg))),

    parameters: ($) => seq('(', commaSep($._formal_parameter), ')'),

    bare_parameters: ($) => seq($._simple_formal_parameter, repeat(seq(',', $._formal_parameter))),

    block_parameters: ($) =>
      seq(
        '|',
        seq(commaSep($._formal_parameter), optional(',')),
        optional(seq(';', sep1(field('locals', $.identifier), ','))), // Block shadow args e.g. {|; a, b| ...}
        '|'
      ),

    _formal_parameter: ($) => choice($._simple_formal_parameter, alias($.parameters, $.destructured_parameter)),

    _simple_formal_parameter: ($) =>
      choice(
        $.identifier,
        $.splat_parameter,
        $.hash_splat_parameter,
        $.hash_splat_nil,
        $.forward_parameter,
        $.block_parameter,
        $.keyword_parameter,
        $.optional_parameter
      ),

    forward_parameter: () => '...',

    splat_parameter: ($) => prec.right(-2, seq('*', field('name', optional($.identifier)))),
    hash_splat_parameter: ($) => seq('**', field('name', optional($.identifier))),
    hash_splat_nil: () => seq('**', 'nil'),
    block_parameter: ($) => seq('&', field('name', optional($.identifier))),
    keyword_parameter: ($) =>
      prec.right(
        PREC.BITWISE_OR + 1,
        seq(field('name', $.identifier), token.immediate(':'), field('value', optional($._arg)))
      ),
    optional_parameter: ($) => prec(PREC.BITWISE_OR + 1, seq(field('name', $.identifier), '=', field('value', $._arg))),

    class: ($) =>
      seq(
        'class',
        field('name', choice($.constant, $.scope_resolution)),
        choice(seq(field('superclass', $.superclass), $._terminator), optional($._terminator)),
        optional(field('body', $.body_statement)),
        'end'
      ),

    superclass: ($) => seq('<', $._expression),

    singleton_class: ($) =>
      seq(
        'class',
        alias($._singleton_class_left_angle_left_langle, '<<'),
        field('value', $._arg),
        $._terminator,
        optional(field('body', $.body_statement)),
        'end'
      ),

    module: ($) =>
      seq(
        'module',
        field('name', choice($.constant, $.scope_resolution)),
        optional($._terminator),
        optional(field('body', $.body_statement)),
        'end'
      ),

    return_command: ($) => prec.left(seq('return', alias($.command_argument_list, $.argument_list))),
    yield_command: ($) => prec.left(seq('yield', alias($._yield_argument_list, $.argument_list))),
    break_command: ($) => prec.left(seq('break', alias($.command_argument_list, $.argument_list))),
    next_command: ($) => prec.left(seq('next', alias($.command_argument_list, $.argument_list))),
    return: () => prec.left('return'),
    yield: ($) => prec.left(seq('yield', optional($.argument_list))),
    break: ($) => prec.left(seq('break', optional($.argument_list))),
    next: ($) => prec.left(seq('next', optional($.argument_list))),
    redo: ($) => prec.left(seq('redo', optional($.argument_list))),
    retry: ($) => prec.left(seq('retry', optional($.argument_list))),

    if_modifier: ($) => prec(PREC.RESCUE, seq(field('body', $._statement), 'if', field('condition', $._expression))),

    unless_modifier: ($) =>
      prec(PREC.RESCUE, seq(field('body', $._statement), 'unless', field('condition', $._expression))),

    while_modifier: ($) =>
      prec(PREC.RESCUE, seq(field('body', $._statement), 'while', field('condition', $._expression))),

    until_modifier: ($) =>
      prec(PREC.RESCUE, seq(field('body', $._statement), 'until', field('condition', $._expression))),

    rescue_modifier: ($) =>
      prec(PREC.RESCUE, seq(field('body', $._statement), 'rescue', field('handler', $._expression))),

    while: ($) => seq('while', field('condition', $._statement), field('body', $.do)),

    until: ($) => seq('until', field('condition', $._statement), field('body', $.do)),

    for: ($) =>
      seq('for', field('pattern', choice($._lhs, $.left_assignment_list)), field('value', $.in), field('body', $.do)),

    in: ($) => seq('in', $._arg),
    do: ($) => seq(choice('do', $._terminator), optional($._statements), 'end'),

    case: ($) =>
      seq(
        'case',
        optional(seq(optional($._line_break), field('value', $._statement))),
        optional($._terminator),
        repeat($.when),
        optional($.else),
        'end'
      ),

    case_match: ($) =>
      seq(
        'case',
        seq(optional($._line_break), field('value', $._statement)),
        optional($._terminator),
        repeat1(field('clauses', $.in_clause)),
        optional(field('else', $.else)),
        'end'
      ),

    when: ($) => seq('when', commaSep1(field('pattern', $.pattern)), choice($._terminator, field('body', $.then))),

    in_clause: ($) =>
      seq(
        'in',
        field('pattern', $._pattern_top_expr_body),
        field('guard', optional($._guard)),
        choice($._terminator, field('body', $.then))
      ),

    pattern: ($) => choice($._arg, $.splat_argument),

    _guard: ($) => choice($.if_guard, $.unless_guard),

    if_guard: ($) => seq('if', field('condition', $._expression)),

    unless_guard: ($) => seq('unless', field('condition', $._expression)),

    _pattern_top_expr_body: ($) =>
      prec(
        -1,
        choice(
          $._pattern_expr,
          alias($._array_pattern_n, $.array_pattern),
          alias($._find_pattern_body, $.find_pattern),
          alias($._hash_pattern_body, $.hash_pattern)
        )
      ),

    _array_pattern_n: ($) =>
      prec.right(
        choice(
          seq($._pattern_expr, alias(',', $.splat_parameter)),
          seq($._pattern_expr, ',', choice($._pattern_expr, $._array_pattern_n)),
          seq($.splat_parameter, repeat(seq(',', $._pattern_expr)))
        )
      ),

    _pattern_expr: ($) => choice($.as_pattern, $._pattern_expr_alt),

    as_pattern: ($) => seq(field('value', $._pattern_expr), '=>', field('name', $.identifier)),

    _pattern_expr_alt: ($) => choice($.alternative_pattern, $._pattern_expr_basic),

    alternative_pattern: ($) =>
      seq(
        field('alternatives', $._pattern_expr_basic),
        repeat1(seq('|', field('alternatives', $._pattern_expr_basic)))
      ),

    _array_pattern_body: ($) => choice($._pattern_expr, $._array_pattern_n),

    array_pattern: ($) =>
      prec.right(
        -1,
        choice(
          seq('[', optional($._array_pattern_body), ']'),
          seq(field('class', $._pattern_constant), token.immediate('['), optional($._array_pattern_body), ']'),
          seq(field('class', $._pattern_constant), token.immediate('('), optional($._array_pattern_body), ')')
        )
      ),

    _find_pattern_body: ($) => seq($.splat_parameter, repeat1(seq(',', $._pattern_expr)), ',', $.splat_parameter),
    find_pattern: ($) =>
      choice(
        seq('[', $._find_pattern_body, ']'),
        seq(field('class', $._pattern_constant), token.immediate('['), $._find_pattern_body, ']'),
        seq(field('class', $._pattern_constant), token.immediate('('), $._find_pattern_body, ')')
      ),

    _hash_pattern_body: ($) =>
      prec.right(
        choice(
          seq(commaSep1($.keyword_pattern), optional(',')),
          seq(commaSep1($.keyword_pattern), ',', $._hash_pattern_any_rest),
          $._hash_pattern_any_rest
        )
      ),

    keyword_pattern: ($) =>
      prec.right(
        -1,
        seq(
          field(
            'key',
            choice(
              alias($.identifier, $.hash_key_symbol),
              alias($.constant, $.hash_key_symbol),
              alias($.identifier_suffix, $.hash_key_symbol),
              alias($.constant_suffix, $.hash_key_symbol),
              $.string
            )
          ),
          token.immediate(':'),
          optional(field('value', $._pattern_expr))
        )
      ),

    _hash_pattern_any_rest: ($) => choice($.hash_splat_parameter, $.hash_splat_nil),

    hash_pattern: ($) =>
      prec.right(
        -1,
        choice(
          seq('{', optional($._hash_pattern_body), '}'),
          seq(field('class', $._pattern_constant), token.immediate('['), $._hash_pattern_body, ']'),
          seq(field('class', $._pattern_constant), token.immediate('('), $._hash_pattern_body, ')')
        )
      ),

    _pattern_expr_basic: ($) =>
      prec.right(
        -1,
        choice($._pattern_value, $.identifier, $.array_pattern, $.find_pattern, $.hash_pattern, $.parenthesized_pattern)
      ),

    parenthesized_pattern: ($) => seq('(', $._pattern_expr, ')'),

    _pattern_value: ($) =>
      prec.right(
        -1,
        choice(
          $._pattern_primitive,
          alias($._pattern_range, $.range),
          $.variable_reference_pattern,
          $.expression_reference_pattern,
          $._pattern_constant
        )
      ),

    _pattern_range: ($) => {
      const begin = field('begin', $._pattern_primitive);
      const end = field('end', $._pattern_primitive);
      const operator = field('operator', choice('..', '...'));
      return choice(seq(begin, operator, end), seq(operator, end), seq(begin, operator));
    },

    _pattern_primitive: ($) => choice($._pattern_literal, $._pattern_lambda),

    _pattern_lambda: ($) => prec.right(-1, $.lambda),

    _pattern_literal: ($) =>
      prec.right(
        -1,
        choice(
          $._literal,
          $.string,
          $.subshell,
          $.heredoc_beginning,
          $.regex,
          $.string_array,
          $.symbol_array,
          $._keyword_variable
        )
      ),

    _keyword_variable: ($) => prec.right(-1, choice($.nil, $.self, $.true, $.false, $.line, $.file, $.encoding)),

    line: () => '__LINE__',
    file: () => '__FILE__',
    encoding: () => '__ENCODING__',

    variable_reference_pattern: ($) => seq('^', field('name', choice($.identifier, $._nonlocal_variable))),

    expression_reference_pattern: ($) => seq('^', '(', field('value', $._expression), ')'),

    _pattern_constant: ($) =>
      prec.right(-1, choice($.constant, alias($._pattern_constant_resolution, $.scope_resolution))),

    _pattern_constant_resolution: ($) =>
      seq(optional(field('scope', $._pattern_constant)), '::', field('name', $.constant)),

    if: ($) =>
      seq(
        'if',
        field('condition', $._statement),
        choice($._terminator, field('consequence', $.then)),
        field('alternative', optional(choice($.else, $.elsif))),
        'end'
      ),

    unless: ($) =>
      seq(
        'unless',
        field('condition', $._statement),
        choice($._terminator, field('consequence', $.then)),
        field('alternative', optional(choice($.else, $.elsif))),
        'end'
      ),

    elsif: ($) =>
      seq(
        'elsif',
        field('condition', $._statement),
        choice($._terminator, field('consequence', $.then)),
        field('alternative', optional(choice($.else, $.elsif)))
      ),

    else: ($) => seq('else', optional($._terminator), optional($._statements)),

    // oxlint-disable-next-line unicorn/no-thenable -- `then` is a grammar rule, whose name is the node type that trees and queries expose.
    then: ($) =>
      choice(seq($._terminator, $._statements), seq(optional($._terminator), 'then', optional($._statements))),

    begin: ($) => seq('begin', optional($._terminator), optional($._body_statement), 'end'),

    ensure: ($) => seq('ensure', optional($._statements)),

    rescue: ($) =>
      seq(
        'rescue',
        field('exceptions', optional($.exceptions)),
        field('variable', optional($.exception_variable)),
        choice($._terminator, field('body', $.then))
      ),

    exceptions: ($) => commaSep1(choice($._arg, $.splat_argument)),

    exception_variable: ($) => seq('=>', $._lhs),

    body_statement: ($) => $._body_statement,

    _body_statement: ($) =>
      choice(
        seq($._statements, repeat(choice($.rescue, $.else, $.ensure))),
        seq(optional($._statements), repeat1(choice($.rescue, $.else, $.ensure)))
      ),

    // Method calls without parentheses (aka "command calls") are only allowed
    // in certain positions, like the top-level of a statement, the condition
    // of a postfix control-flow operator like `if`, or as the value of a
    // control-flow statement like `return`. In many other places, they're not
    // allowed.
    //
    // Because of this distinction, a lot of rules have two variants: the
    // normal variant, which can appear anywhere that an expression is valid,
    // and the "command" varaint, which is only valid in a more limited set of
    // positions, because it can contain "command calls".
    //
    // The `_expression` rule can appear in relatively few places, but can
    // contain command calls. The `_arg` rule can appear in many more places,
    // but cannot contain command calls (unless they are wrapped in parens).
    // This naming convention is based on Ruby's standard grammar.
    _expression: ($) =>
      choice(
        $._non_pattern_expression,
        alias($._chained_match_pattern, $.match_pattern),
        alias($._negated_command_match_pattern, $.match_pattern),
        alias($._chained_test_pattern, $.test_pattern),
        $.match_pattern,
        $.test_pattern
      ),

    _non_pattern_expression: ($) =>
      choice(
        alias($.command_binary, $.binary),
        alias($.command_unary, $.unary),
        $._command_unary_arg,
        $._command_value
      ),

    _command_value: ($) => commandValue($, true),

    _command_value_expression: ($) => $._command_value,

    _command_not_operand_expression: ($) =>
      prec.right(
        PREC.NOT - 1,
        choice(
          commandValue($, false),
          alias($._ordinary_chained_assignment, $.assignment),
          alias($.command_operator_assignment, $.operator_assignment),
          alias($._chained_operator_assignment, $.operator_assignment),
          alias($.command_unary, $.unary),
          $._command_unary_arg,
          prec.dynamic(3, $.match_pattern)
        )
      ),

    _yield_not_operand_expression: ($) =>
      choice(
        $._yield_value,
        alias($._yield_unary, $.unary),
        alias($._yield_not_operator_assignment, $.operator_assignment)
      ),

    _test_pattern_not_operand_expression: ($) =>
      choice(
        $.test_pattern,
        alias($._negated_chained_test_pattern, $.test_pattern),
        alias($._test_pattern_not, $.unary)
      ),

    _yield_pattern_not_operand_expression: ($) =>
      choice($.test_pattern, alias($._yield_test_pattern, $.test_pattern), alias($._yield_pattern_not, $.unary)),

    _argument_command_value: ($) =>
      choice(
        commandValue($, false),
        alias($._ordinary_chained_assignment, $.assignment),
        alias($._ordinary_chained_operator_assignment, $.operator_assignment)
      ),

    _chained_match_pattern: ($) =>
      choice(
        prec.dynamic(
          1,
          seq(
            field(
              'value',
              choice(
                $._chained_arg,
                alias($._chained_command, $.call),
                alias($._pattern_command_assignment, $.assignment),
                alias($._pattern_chained_assignment, $.assignment),
                alias($._chained_operator_assignment, $.operator_assignment),
                alias($.command_operator_assignment, $.operator_assignment),
                alias($.command_call_with_block, $.call),
                alias($._receiver_command, $.call),
                alias($._command_method, $.method),
                alias($._command_singleton_method, $.singleton_method),
                alias($._pattern_command_binary, $.binary),
                alias($.command_unary, $.unary),
                $._command_unary_arg,
                alias($.yield_command, $.yield)
              )
            ),
            '=>',
            field('pattern', $._pattern_top_expr_body)
          )
        ),
        seq(
          field('value', choice($.if_modifier, $.unless_modifier, $.while_modifier, $.until_modifier)),
          '=>',
          field('pattern', $._pattern_top_expr_body)
        ),
        prec(
          PREC.PATTERN,
          seq(field('value', alias($._super_command, $.call)), '=>', field('pattern', $._pattern_top_expr_body))
        )
      ),
    _negated_command_match_pattern: ($) =>
      prec(
        PREC.PATTERN,
        seq(field('value', alias($._pattern_command_not, $.unary)), '=>', field('pattern', $._pattern_top_expr_body))
      ),

    _chained_test_pattern: ($) => chainedTestPattern($),

    _negated_chained_test_pattern: ($) => prec(PREC.PATTERN, chainedTestPattern($, false)),

    match_pattern: ($) =>
      prec(
        PREC.PATTERN,
        prec.dynamic(
          1,
          seq(field('value', alias($._pattern_arg, $._arg)), '=>', field('pattern', $._pattern_top_expr_body))
        )
      ),

    test_pattern: ($) =>
      prec(
        PREC.PATTERN,
        prec.dynamic(
          2,
          seq(field('value', alias($._pattern_arg, $._arg)), 'in', field('pattern', $._pattern_top_expr_body))
        )
      ),

    _pattern_arg: ($) =>
      choice(
        alias($._unary_minus_pow, $.unary),
        $._primary,
        $.operator_assignment,
        $.conditional,
        $.range,
        $.binary,
        alias($._pattern_unary, $.unary),
        alias($._pattern_assignment, $.assignment)
      ),

    _pattern_unary: ($) =>
      choice(
        prec(PREC.DEFINED, seq(field('operator', 'defined?'), field('operand', choice($._arg, $.begin)))),
        strongUnaryExpression($._arg, choice(alias($._unary_minus, '-'), '+'))
      ),

    _arg: ($) =>
      choice(
        alias($._unary_minus_pow, $.unary),
        $._primary,
        $.assignment,
        $.operator_assignment,
        $.conditional,
        $.range,
        $.binary,
        $.unary
      ),

    _unary_minus_pow: ($) =>
      seq(field('operator', alias($._unary_minus_num, '-')), field('operand', alias($._pow, $.binary))),
    _pow: ($) =>
      prec.right(
        PREC.EXPONENTIAL,
        seq(
          field('left', $._simple_numeric),
          field('operator', alias($._binary_star_star, '**')),
          field('right', $._arg)
        )
      ),

    _primary: ($) => primaryExpression($, $._lhs, $.call, $.method, $.singleton_method),

    parenthesized_statements: ($) => seq('(', optional($._statements), ')'),

    element_reference: ($) => elementReference($, $._primary),

    scope_resolution: ($) =>
      prec.left(
        PREC.CALL + 1,
        seq(choice('::', seq(field('scope', $._primary), token.immediate('::'))), field('name', $.constant))
      ),

    _call_operator: () => choice('.', '&.', token.immediate('::')),
    _call: ($) =>
      prec.left(
        PREC.CALL,
        seq(
          field('receiver', $._primary),
          field('operator', $._call_operator),
          field('method', choice($.identifier, $.operator, $.constant, $._function_identifier))
        )
      ),

    command_call: ($) =>
      choice(
        seq(
          field('method', choice($._variable, $._function_identifier)),
          field('arguments', alias($.command_argument_list, $.argument_list))
        ),
        $._super_command,
        $._receiver_command,
        $._chained_command
      ),

    _super_command: ($) =>
      prec.dynamic(
        1,
        seq(
          field('method', $.super),
          field(
            'arguments',
            choice(
              alias($.command_argument_list, $.argument_list),
              alias($._signed_command_argument_list, $.argument_list)
            )
          )
        )
      ),

    _receiver_command: ($) => seq($._call, field('arguments', alias($.command_argument_list, $.argument_list))),

    _chained_command: ($) =>
      seq($._chained_command_call, field('arguments', alias($._chained_command_argument_list, $.argument_list))),

    command_call_with_block: ($) =>
      choice(
        commandCallWithBlock(
          $,
          choice($._call, field('method', choice($._variable, $._function_identifier, $.super))),
          $.command_argument_list
        ),
        commandCallWithBlock($, $._chained_command_call, $._chained_command_argument_list)
      ),

    _super_command_with_block: ($) => commandCallWithBlock($, field('method', $.super), $.command_argument_list),

    _chained_arg: ($) =>
      choice(
        $._chained_primary,
        alias($._chained_binary, $.binary),
        alias($._chained_conditional, $.conditional),
        alias($._chained_range, $.range)
      ),

    _chained_primary: ($) =>
      choice(
        prec.left(alias($._chained_command_call, $.call)),
        alias($._chained_call, $.call),
        alias($._chained_element_reference, $.element_reference),
        alias($._chained_scope_resolution, $.scope_resolution)
      ),

    _chained_command_call: ($) =>
      seq(
        field('receiver', choice(alias($.command_call_with_block, $.call), $._chained_primary)),
        field('operator', $._call_operator),
        field('method', choice($.identifier, $._function_identifier, $.operator, $.constant))
      ),

    _chained_scope_resolution: ($) =>
      prec.left(
        PREC.CALL + 1,
        seq(field('scope', $._chained_primary), token.immediate('::'), field('name', $.constant))
      ),

    _chained_element_reference: ($) => elementReference($, $._chained_primary),

    _chained_call: ($) => {
      const receiver = $._chained_command_call;
      const receiverArguments = seq(
        choice(receiver, seq(field('receiver', $._chained_primary), field('operator', $._call_operator))),
        field('arguments', $.argument_list)
      );
      return choice(
        receiverArguments,
        prec(PREC.CURLY_BLOCK, seq(choice(receiver, receiverArguments), field('block', $.block))),
        prec(PREC.DO_BLOCK, seq(choice(receiver, receiverArguments), field('block', $.do_block)))
      );
    },

    call: ($) => callExpression($, $._primary, $._call),

    _chained_command_argument_list: ($) =>
      prec.right(choice(commaSep1($._command_argument), $._signed_command_argument_list)),

    _signed_command_argument_list: ($) =>
      prec.right(
        seq(choice($._chained_plus_arg, alias($._chained_plus_pair, $.pair)), repeat(seq(',', $._command_argument)))
      ),

    _chained_plus_arg: ($) =>
      choice(
        alias($._chained_plus_argument, $.unary),
        alias($._chained_plus_binary, $.binary),
        alias($._chained_plus_conditional, $.conditional),
        alias($._chained_plus_range, $.range)
      ),
    _chained_plus_binary: ($) => binaryExpression($, $._chained_plus_arg),
    _chained_plus_conditional: ($) => conditionalExpression($, $._chained_plus_arg),
    _chained_plus_range: ($) => rangeExpression($, $._chained_plus_arg, false),
    _chained_plus_pair: ($) => prec.right(seq(field('key', $._chained_plus_arg), '=>', field('value', $._arg))),
    _chained_plus_argument: ($) =>
      prec.right(PREC.COMPLEMENT, seq(field('operator', alias($._unary_plus, '+')), field('operand', $._arg))),

    command_argument_list: ($) => prec.right(commaSep1($._command_argument)),

    _yield_argument_list: ($) => prec.right(commaSep1($._yield_argument)),

    _yield_argument: ($) =>
      prec.left(1, argument($, alias($._yield_argument_expression, $._expression), $._yield_command_pair)),

    _yield_argument_expression: ($) => prec(PREC.RESCUE, $._yield_value),

    _yield_value: ($) =>
      choice(
        $._arg,
        alias($._yield_call, $.call),
        alias($._yield_not, $.unary),
        alias($._yield_pattern_not, $.unary),
        alias($._yield_method, $.method),
        alias($._yield_singleton_method, $.singleton_method),
        alias($.yield_command, $.yield)
      ),

    _yield_call: ($) =>
      choice(
        seq(
          choice(field('method', choice($._variable, $._function_identifier, $.super)), $._call),
          field('arguments', alias($._yield_argument_list, $.argument_list))
        ),
        seq(field('method', $.super), field('arguments', alias($._yield_signed_argument_list, $.argument_list)))
      ),

    _yield_signed_argument_list: ($) =>
      prec.right(
        seq(choice($._chained_plus_arg, alias($._chained_plus_pair, $.pair)), repeat(seq(',', $._yield_argument)))
      ),

    _yield_not: ($) =>
      prec.right(
        PREC.NOT,
        seq(field('operator', 'not'), field('operand', alias($._yield_not_operand_expression, $._expression)))
      ),

    _yield_not_operator_assignment: ($) =>
      prec.right(
        PREC.ASSIGN,
        seq(
          field('left', choice($._lhs, $._chained_lhs)),
          field('operator', assignmentOperator($)),
          field('right', alias($._yield_assignment_rhs, $._expression))
        )
      ),

    _yield_nested_assignment: ($) =>
      prec.right(
        PREC.ASSIGN,
        seq(
          field('left', choice($._lhs, $._chained_lhs)),
          '=',
          field('right', alias($._yield_assignment_rhs, $._expression))
        )
      ),

    _yield_assignment_rhs: ($) =>
      choice(
        $._yield_value,
        alias($._yield_not_operator_assignment, $.operator_assignment),
        alias($._yield_nested_assignment, $.assignment),
        alias($._yield_rescue, $.rescue_modifier)
      ),

    _yield_unary: ($) =>
      prec.right(
        PREC.COMPLEMENT,
        seq(field('operator', '!'), field('operand', alias($._yield_argument_expression, $._expression)))
      ),

    _yield_pattern_not: ($) =>
      prec.dynamic(
        3,
        prec.right(
          PREC.NOT,
          seq(field('operator', 'not'), field('operand', alias($._yield_pattern_not_operand_expression, $._expression)))
        )
      ),

    _yield_test_pattern: ($) =>
      prec(
        PREC.PATTERN,
        prec.dynamic(
          1,
          seq(
            field(
              'value',
              choice(
                alias($._yield_not, $.unary),
                alias($._yield_unary, $.unary),
                alias($._yield_method, $.method),
                alias($._yield_singleton_method, $.singleton_method),
                alias($.yield_command, $.yield)
              )
            ),
            'in',
            field('pattern', $._pattern_top_expr_body)
          )
        )
      ),

    _yield_method: ($) => seq('def', $._yield_method_rest),

    _yield_singleton_method: ($) => singletonMethod($, $._yield_method_rest),

    _yield_method_rest: ($) => endlessMethodRest($, endlessBody($, $._yield_value, $._yield_method_body_rescue)),

    _yield_method_body_rescue: ($) => endlessBodyRescue($, $._yield_value),

    _yield_rescue: ($) =>
      prec(
        PREC.RESCUE,
        seq(field('body', alias($._yield_argument_expression, $._expression)), 'rescue', field('handler', $._arg))
      ),

    argument_list: ($) => prec.right(seq(token.immediate('('), optional($._argument_list_with_trailing_comma), ')')),

    _argument_list_with_trailing_comma: ($) =>
      prec.right(seq($._argument, repeat(seq(',', $._value_argument)), optional(','))),

    _value_argument_expression: ($) => $._arg,

    _command_argument_expression: ($) => $._argument_command_value,

    _value_argument: ($) =>
      prec.left(
        choice(
          alias($._value_argument_expression, $._expression),
          $.splat_argument,
          $.hash_splat_argument,
          $.forward_argument,
          $.block_argument,
          $.pair
        )
      ),

    _command_argument: ($) =>
      prec.left(
        1,
        choice(
          alias($._command_argument_expression, $._expression),
          $.splat_argument,
          $.hash_splat_argument,
          $.forward_argument,
          $.block_argument,
          $.pair,
          alias($._command_definition_pair, $.pair),
          alias($._command_pair, $.pair)
        )
      ),

    _command_pair: ($) => commandPair($, $._command_pair_key),

    _yield_command_pair: ($) => commandPair($, $._yield_command_pair_key, false),

    _yield_command_pair_key: ($) =>
      seq(
        choice(field('method', choice($._variable, $._function_identifier)), $._call),
        field('arguments', alias($._yield_command_pair_key_arguments, $.argument_list))
      ),

    _yield_command_pair_key_arguments: ($) =>
      prec.left(1, choice(alias($._yield_call_pair_key, $.call), alias($._pair_block_argument, $.block_argument))),

    _yield_pair_key: ($) => prec.left(seq('yield', alias($._yield_pair_key_arguments, $.argument_list))),

    _yield_pair_key_arguments: ($) => yieldPairKeyArguments($, true),

    _yield_call_pair_key_arguments: ($) => yieldPairKeyArguments($, false),

    _yield_call_pair_key: ($) =>
      seq(
        choice(field('method', choice($._variable, $._function_identifier, $.super)), $._call),
        field('arguments', alias($._yield_call_pair_key_arguments, $.argument_list))
      ),

    _command_pair_key: ($) =>
      seq(
        choice(field('method', choice($._variable, $._function_identifier)), $._call),
        field('arguments', alias($._command_pair_key_arguments, $.argument_list))
      ),

    _command_pair_key_arguments: ($) =>
      prec.left(
        1,
        choice(
          alias($.command_call, $.call),
          alias($.command_call_with_block, $.call),
          alias($._pair_block_argument, $.block_argument)
        )
      ),

    _pair_block_argument: ($) => prec.dynamic(1, seq(alias($._block_ampersand, '&'), $._arg)),

    _command_definition_pair: ($) =>
      prec.dynamic(
        2,
        prec.right(
          seq(
            field(
              'key',
              choice(alias($._command_method, $.method), alias($._command_singleton_method, $.singleton_method))
            ),
            '=>',
            field('value', $._arg)
          )
        )
      ),

    _argument: ($) => argument($, alias($._argument_expression, $._expression)),

    _argument_expression: ($) => choice($._argument_command_value, $.match_pattern, $.test_pattern),

    forward_argument: () => '...',
    splat_argument: ($) => prec.right(seq(alias($._splat_star, '*'), optional($._arg))),
    hash_splat_argument: ($) => prec.right(seq(alias($._hash_splat_star_star, '**'), optional($._arg))),
    block_argument: ($) => prec.right(seq(alias($._block_ampersand, '&'), optional($._arg))),

    do_block: ($) =>
      seq(
        'do',
        optional($._terminator),
        optional(seq(field('parameters', $.block_parameters), optional($._terminator))),
        optional(field('body', $.body_statement)),
        'end'
      ),

    block: ($) =>
      prec(
        PREC.CURLY_BLOCK,
        prec.dynamic(
          2,
          seq(
            $._block_open,
            field('parameters', optional($.block_parameters)),
            optional(field('body', $.block_body)),
            '}'
          )
        )
      ),

    // Where both a block and a hash argument can start (`foo {`, `x.y {`), the `{` would otherwise be shared until a
    // later conflict picks the hash. Reducing the brace on its own forces the choice right after it, and the precedence
    // makes it a block, as in Ruby.
    _block_open: () => prec(PREC.CURLY_BLOCK, '{'),

    _arg_rhs: ($) => choice($._arg, alias($.rescue_modifier_arg, $.rescue_modifier)),

    _ordinary_rhs_expression: ($) => prec(PREC.ASSIGN, $._arg_rhs),
    _chained_lhs: ($) =>
      choice(
        alias($._chained_command_call, $.call),
        alias($._chained_element_reference, $.element_reference),
        alias($._chained_scope_resolution, $.scope_resolution)
      ),

    _chained_left_assignment_list: ($) =>
      prec.left(
        -1,
        seq(
          $._chained_lhs,
          ',',
          optional(seq(commaSep1(choice($._lhs, $.rest_assignment, $.destructured_left_assignment)), optional(',')))
        )
      ),

    _chained_assignment: ($) =>
      prec.right(
        PREC.ASSIGN,
        seq(
          field('left', choice($._chained_lhs, alias($._chained_left_assignment_list, $.left_assignment_list))),
          '=',
          field(
            'right',
            choice(
              alias($._command_value_expression, $._expression),
              $.splat_argument,
              $.right_assignment_list,
              alias($._command_value_rescue, $.rescue_modifier)
            )
          )
        )
      ),

    _chained_operator_assignment: ($) =>
      prec.right(
        PREC.ASSIGN,
        seq(
          field('left', $._chained_lhs),
          field('operator', assignmentOperator($)),
          field(
            'right',
            choice(alias($._command_value_expression, $._expression), alias($._command_value_rescue, $.rescue_modifier))
          )
        )
      ),

    _pattern_assignment: ($) =>
      prec.right(
        PREC.ASSIGN,
        seq(field('left', $._lhs), '=', field('right', alias($._ordinary_rhs_expression, $._expression)))
      ),

    _pattern_command_assignment: ($) =>
      prec.right(
        PREC.ASSIGN,
        seq(
          field('left', $._lhs),
          '=',
          field(
            'right',
            choice(alias($._command_value_expression, $._expression), alias($._command_value_rescue, $.rescue_modifier))
          )
        )
      ),

    _pattern_chained_assignment: ($) =>
      prec.right(
        PREC.ASSIGN,
        seq(
          field('left', $._chained_lhs),
          '=',
          field(
            'right',
            choice(alias($._command_value_expression, $._expression), alias($._command_value_rescue, $.rescue_modifier))
          )
        )
      ),

    assignment: ($) =>
      prec.right(
        PREC.ASSIGN,
        choice(
          seq(
            field('left', choice($._lhs, $.left_assignment_list)),
            '=',
            field(
              'right',
              choice(alias($._ordinary_rhs_expression, $._expression), $.splat_argument, $.right_assignment_list)
            )
          )
        )
      ),

    command_assignment: ($) =>
      prec.right(
        PREC.ASSIGN,
        seq(
          field('left', choice($._lhs, $.left_assignment_list)),
          '=',
          field(
            'right',
            choice(alias($._command_value_expression, $._expression), alias($._command_value_rescue, $.rescue_modifier))
          )
        )
      ),

    operator_assignment: ($) =>
      prec.right(
        PREC.ASSIGN,
        seq(
          field('left', $._lhs),
          field('operator', assignmentOperator($)),
          field('right', alias($._ordinary_rhs_expression, $._expression))
        )
      ),

    command_operator_assignment: ($) =>
      prec.right(
        PREC.ASSIGN,
        seq(
          field('left', $._lhs),
          field('operator', assignmentOperator($)),
          field(
            'right',
            choice(alias($._command_value_expression, $._expression), alias($._command_value_rescue, $.rescue_modifier))
          )
        )
      ),

    conditional: ($) => conditionalExpression($, $._arg),

    _chained_conditional: ($) => conditionalExpression($, $._chained_arg),

    range: ($) => rangeExpression($, $._arg, true),

    _chained_range: ($) => rangeExpression($, $._chained_arg, false),

    _range_sign: ($) =>
      prec.right(PREC.UNARY_MINUS, seq(field('operator', alias($._binary_minus, '-')), field('operand', $._arg))),

    _chained_binary: ($) => binaryExpression($, choice($._chained_arg, alias($.command_call_with_block, $.call))),

    _chained_unary: ($) =>
      prec.right(
        PREC.COMPLEMENT,
        seq(field('operator', '!'), field('operand', choice($._chained_arg, alias($.command_call_with_block, $.call))))
      ),

    _command_unary_arg: ($) =>
      choice(
        alias($._chained_unary, $.unary),
        alias($._command_unary_binary, $.binary),
        alias($._command_unary_conditional, $.conditional),
        alias($._command_unary_range, $.range)
      ),

    _command_unary_binary: ($) => binaryExpression($, $._command_unary_arg),

    _command_unary_conditional: ($) => conditionalExpression($, $._command_unary_arg),

    _command_unary_range: ($) => rangeExpression($, $._command_unary_arg, false),

    binary: ($) => binaryExpression($, $._arg),

    _pattern_command_binary: ($) =>
      prec.left(
        1,
        seq(
          field('left', $._expression),
          field('operator', choice('or', 'and')),
          field('right', alias($.command_call, $.call))
        )
      ),

    command_binary: ($) =>
      prec.left(
        1,
        seq(field('left', $._expression), field('operator', choice('or', 'and')), field('right', $._expression))
      ),

    unary: ($) => unaryExpression($._arg, choice(alias($._unary_minus, '-'), '+'), choice($._arg, $.begin)),

    command_unary: ($) =>
      prec.right(
        PREC.COMPLEMENT,
        seq(field('operator', '!'), field('operand', alias($._command_argument_expression, $._expression)))
      ),

    _pattern_command_operand_expression: ($) => alias($.command_call, $.call),

    _pattern_command_not: ($) =>
      prec.right(
        PREC.NOT,
        seq(field('operator', 'not'), field('operand', alias($._pattern_command_operand_expression, $._expression)))
      ),

    _command_not: ($) =>
      prec.right(
        PREC.NOT,
        seq(field('operator', 'not'), field('operand', alias($._command_not_operand_expression, $._expression)))
      ),

    _ordinary_chained_assignment: ($) =>
      prec.right(
        PREC.ASSIGN,
        seq(field('left', $._chained_lhs), '=', field('right', alias($._ordinary_rhs_expression, $._expression)))
      ),

    _ordinary_chained_operator_assignment: ($) =>
      prec.right(
        PREC.ASSIGN,
        seq(
          field('left', $._chained_lhs),
          field('operator', assignmentOperator($)),
          field('right', alias($._ordinary_rhs_expression, $._expression))
        )
      ),

    _test_pattern_not: ($) =>
      prec.dynamic(
        3,
        prec.right(
          PREC.NOT,
          seq(field('operator', 'not'), field('operand', alias($._test_pattern_not_operand_expression, $._expression)))
        )
      ),

    parenthesized_unary: ($) =>
      choice(
        prec(PREC.CALL, seq(field('operator', 'defined?'), field('operand', $.parenthesized_statements))),
        prec(
          PREC.CALL,
          seq(field('operator', alias($._not_parenthesized, 'not')), field('operand', $.parenthesized_statements))
        )
      ),

    unary_literal: ($) =>
      prec.right(
        PREC.UNARY_MINUS,
        seq(field('operator', choice(alias($._unary_minus_num, '-'), '+')), field('operand', $._simple_numeric))
      ),

    _literal: ($) => choice($.simple_symbol, $.delimited_symbol, $._numeric),

    _numeric: ($) => choice($._simple_numeric, alias($.unary_literal, $.unary)),

    _simple_numeric: ($) => choice($.integer, $.float, $.complex, $.rational),

    right_assignment_list: ($) => prec(-1, commaSep1(choice($._arg, $.splat_argument))),

    left_assignment_list: ($) => $._mlhs,
    _mlhs: ($) =>
      prec.left(-1, seq(commaSep1(choice($._lhs, $.rest_assignment, $.destructured_left_assignment)), optional(','))),
    destructured_left_assignment: ($) => prec(-1, seq('(', $._mlhs, ')')),

    rest_assignment: ($) => prec(-1, seq('*', optional($._lhs))),

    _function_identifier: ($) => choice(alias($.identifier_suffix, $.identifier), alias($.constant_suffix, $.constant)),
    _function_identifier_call: ($) => prec.left(field('method', $._function_identifier)),
    _lhs: ($) => leftHandSide($, $.scope_resolution, $.element_reference, alias($._call, $.call)),

    _variable: ($) => prec.right(choice($.super, reserved('variables', $.identifier), $.constant)),

    operator: () =>
      choice(
        '..',
        '|',
        '^',
        '&',
        '<=>',
        '==',
        '===',
        '=~',
        '>',
        '>=',
        '<',
        '<=',
        '+',
        '!=',
        '-',
        '*',
        '/',
        '%',
        '!',
        '!~',
        '**',
        '<<',
        '>>',
        '~',
        '+@',
        '-@',
        '~@',
        '[]',
        '[]=',
        '`'
      ),

    _method_name: ($) =>
      choice(
        reserved('methodNames', $.identifier),
        $._function_identifier,
        $.constant,
        $.setter,
        $.simple_symbol,
        $.delimited_symbol,
        $.operator,
        $._nonlocal_variable
      ),

    _nonlocal_variable: ($) => choice($.instance_variable, $.class_variable, $.global_variable),

    setter: ($) => seq(field('name', $.identifier), token.immediate('=')),

    undef: ($) => seq('undef', commaSep1($._method_name)),
    alias: ($) => seq('alias', field('name', $._method_name), field('alias', $._method_name)),

    comment: ($) => choice($._line_comment, $._block_comment, token(prec(PREC.COMMENT, seq('#', /.*/)))),

    integer: () => /0[bB][01](_?[01])*|0[oO]?[0-7](_?[0-7])*|(0[dD])?\d(_?\d)*|0[xX][0-9a-fA-F](_?[0-9a-fA-F])*/,
    _int_or_float: ($) => choice($.integer, $.float),
    // oxlint-disable-next-line no-useless-escape -- The regex source reaches src/grammar.json as written, so it keeps upstream's spelling.
    float: () => /\d(_?\d)*(\.\d)?(_?\d)*([eE][\+-]?\d(_?\d)*)?/,
    complex: ($) =>
      choice(
        seq($._int_or_float, token.immediate('i')),
        seq(alias($._int_or_float, $.rational), token.immediate('ri'))
      ),
    rational: ($) => seq($._int_or_float, token.immediate('r')),
    super: () => 'super',
    self: () => 'self',
    true: () => 'true',
    false: () => 'false',
    nil: () => 'nil',

    constant: () => token(seq(/[A-Z]/, IDENTIFIER_CHARS)),
    constant_suffix: ($) => choice(token(seq(/[A-Z]/, IDENTIFIER_CHARS, /[?]/)), $._constant_suffix),
    identifier: () => token(seq(LOWER_ALPHA_CHAR, IDENTIFIER_CHARS)),
    identifier_suffix: ($) => choice(token(seq(LOWER_ALPHA_CHAR, IDENTIFIER_CHARS, /[?]/)), $._identifier_suffix),
    instance_variable: () => token(seq('@', ALPHA_CHAR, IDENTIFIER_CHARS)),
    class_variable: () => token(seq('@@', ALPHA_CHAR, IDENTIFIER_CHARS)),

    global_variable: () =>
      token(
        choice(
          /\$(-[a-zA-Z0-9_]|[!@&`'+~=/\\,;.<>*$?:"]|[0-9]+)/,
          seq('$-', /[^\u0000-\u007F]/),
          seq('$', ALPHA_CHAR, IDENTIFIER_CHARS)
        )
      ),

    chained_string: ($) => seq($.string, repeat1($.string)),

    character: () => /\?(\\\S(\{[0-9A-Fa-f]*\}|[0-9A-Fa-f]*|-\S([MC]-\S)?)?|\S)/,

    interpolation: ($) =>
      choice(seq('#{', optional($._statements), '}'), seq($._short_interpolation, $._nonlocal_variable)),

    string: ($) => seq(alias($._string_start, '"'), optional($._literal_contents), alias($._string_end, '"')),

    subshell: ($) => seq(alias($._subshell_start, '`'), optional($._literal_contents), alias($._string_end, '`')),

    string_array: ($) =>
      seq(
        alias($._string_array_start, '%w('),
        optional(/\s+/),
        sep(alias($._literal_contents, $.bare_string), /\s+/),
        optional(/\s+/),
        alias($._string_end, ')')
      ),

    symbol_array: ($) =>
      seq(
        alias($._symbol_array_start, '%i('),
        optional(/\s+/),
        sep(alias($._literal_contents, $.bare_symbol), /\s+/),
        optional(/\s+/),
        alias($._string_end, ')')
      ),

    delimited_symbol: ($) =>
      seq(alias($._symbol_start, ':"'), optional($._literal_contents), alias($._string_end, '"')),

    regex: ($) => seq(alias($._regex_start, '/'), optional($._literal_contents), alias($._string_end, '/')),

    heredoc_body: ($) =>
      seq($._heredoc_body_start, repeat(choice($.heredoc_content, $.interpolation, $.escape_sequence)), $.heredoc_end),

    _literal_contents: ($) => repeat1(choice($.string_content, $.interpolation, $.escape_sequence)),

    // https://ruby-doc.org/core-2.5.0/doc/syntax/literals_rdoc.html#label-Strings
    escape_sequence: () =>
      token(
        seq(
          '\\',
          choice(
            /\r\n/,
            /[^ux0-7]/, // single character
            /x[0-9a-fA-F]{1,2}/, // hex code
            /[0-7]{1,3}/, // octal
            /u[0-9a-fA-F]{4}/, // single unicode
            /u\{[0-9a-fA-F ]+\}/ // multiple unicode
          )
        )
      ),

    array: ($) => seq('[', optional(seq(commaSep1($._value_argument), optional(','))), ']'),

    hash: ($) => seq('{', optional(seq(commaSep1(choice($.pair, $.hash_splat_argument)), optional(','))), '}'),

    pair: ($) =>
      prec.dynamic(
        3,
        prec.right(
          choice(
            seq(field('key', $._arg), '=>', field('value', $._arg)),
            seq(field('key', choice($.string)), token.immediate(':'), field('value', $._arg)),
            seq(
              field(
                'key',
                choice(
                  $.hash_key_symbol,
                  alias($.identifier, $.hash_key_symbol),
                  alias($.constant, $.hash_key_symbol),
                  alias($.identifier_suffix, $.hash_key_symbol),
                  alias($.constant_suffix, $.hash_key_symbol)
                )
              ),
              token.immediate(':'),
              choice(
                field('value', optional($._arg)),
                // This alternative never matches, because '_no_line_break' tokens do not exist.
                // The purpose is give a hint to the scanner that it should not produce any line-break
                // terminators at this point.
                $._no_line_break
              )
            )
          )
        )
      ),

    lambda: ($) =>
      seq(
        '->',
        field(
          'parameters',
          optional(
            choice(
              alias($._parenthesized_lambda_parameters, $.lambda_parameters),
              alias($.bare_parameters, $.lambda_parameters)
            )
          )
        ),
        field('body', choice(alias($._lambda_block, $.block), $.do_block))
      ),

    // As with parse.y's tLAMBEG, the scanner emits this `{` where a lambda body can start, so that it opens the body
    // after bare parameters even where a parameter default could take a block or start a hash (`-> a=b() { }`,
    // `-> x: { }`).
    _lambda_block: ($) =>
      seq(
        alias($._lambda_brace, '{'),
        field('parameters', optional($.block_parameters)),
        optional(field('body', $.block_body)),
        '}'
      ),

    _parenthesized_lambda_parameters: ($) =>
      seq('(', commaSep($._formal_parameter), optional(seq(';', sep1(field('locals', $.identifier), ','))), ')'),

    empty_statement: () => prec(-1, ';'),

    _terminator: ($) => choice(prec.dynamic(1, $._line_break), ';'),
  },
});

/**
 * Creates a rule to optionally match one or more of the rules separated by `separator`
 *
 * @param {RuleOrLiteral} rule
 *
 * @param {RuleOrLiteral} separator
 *
 * @returns {ChoiceRule}
 */
function sep(rule, separator) {
  return optional(sep1(rule, separator));
}

/**
 * Creates a rule to match one or more of the rules separated by `separator`
 *
 * @param {RuleOrLiteral} rule
 *
 * @param {RuleOrLiteral} separator
 *
 * @returns {SeqRule}
 */
function sep1(rule, separator) {
  return seq(rule, repeat(seq(separator, rule)));
}

/**
 * Creates a rule to match one or more of the rules separated by a comma
 *
 * @param {RuleOrLiteral} rule
 *
 * @returns {SeqRule}
 */
function commaSep1(rule) {
  return sep1(rule, ',');
}

/**
 * Creates a rule to optionally match one or more of the rules separated by a comma
 *
 * @param {RuleOrLiteral} rule
 *
 * @returns {ChoiceRule}
 */
function commaSep(rule) {
  return optional(commaSep1(rule));
}

/**
 * @param {GrammarSymbols<string>} $
 */
function assignmentOperator($) {
  return choice(
    '+=',
    '-=',
    '*=',
    '**=',
    '/=',
    '||=',
    '|=',
    '&&=',
    '&=',
    alias($._modulo_assignment, '%='),
    '>>=',
    '<<=',
    '^='
  );
}

/**
 * @param {RuleOrLiteral} operand
 * @param {RuleOrLiteral} sign
 * @param {RuleOrLiteral} [definedOperand]
 */
function unaryExpression(operand, sign, definedOperand = operand) {
  return choice(
    prec(PREC.DEFINED, seq(field('operator', 'defined?'), field('operand', definedOperand))),
    prec.right(PREC.NOT, seq(field('operator', 'not'), field('operand', operand))),
    strongUnaryExpression(operand, sign)
  );
}

/**
 * @param {RuleOrLiteral} operand
 * @param {RuleOrLiteral} sign
 */
function strongUnaryExpression(operand, sign) {
  return choice(
    prec.right(PREC.UNARY_MINUS, seq(field('operator', sign), field('operand', operand))),
    prec.right(PREC.COMPLEMENT, seq(field('operator', choice('!', '~')), field('operand', operand)))
  );
}

/**
 * @param {GrammarSymbols<string>} $
 * @param {RuleOrLiteral} left
 * @param {RuleOrLiteral} right
 */
function binaryExpression($, left, right = $._arg) {
  // oxlint-disable typescript/unbound-method -- The DSL's `prec` functions do not use `this`.
  /** @type {[(precedence: number, rule: RuleOrLiteral) => Rule, number, RuleOrLiteral][]} */
  const operators = [
    [prec.left, PREC.AND, 'and'],
    [prec.left, PREC.OR, 'or'],
    [prec.left, PREC.BOOLEAN_OR, '||'],
    [prec.left, PREC.BOOLEAN_AND, '&&'],
    [prec.left, PREC.SHIFT, choice('<<', '>>')],
    [prec.left, PREC.COMPARISON, choice('<', '<=', '>', '>=')],
    [prec.left, PREC.BITWISE_AND, alias($._bitwise_and, '&')],
    [prec.left, PREC.BITWISE_OR, choice('^', '|')],
    [prec.left, PREC.ADDITIVE, choice('+', alias($._binary_plus, '+'), alias($._binary_minus, '-'))],
    [prec.left, PREC.MULTIPLICATIVE, choice('/', '%', alias($._binary_star, '*'))],
    [prec.right, PREC.RELATIONAL, choice('==', '!=', '===', '<=>', '=~', '!~')],
    [prec.right, PREC.EXPONENTIAL, alias($._binary_star_star, '**')],
  ];
  // oxlint-enable typescript/unbound-method

  return choice(
    ...operators.map(([fn, precedence, operator]) =>
      fn(precedence, seq(field('left', left), field('operator', operator), field('right', right)))
    )
  );
}

/**
 * @param {GrammarSymbols<string>} $
 * @param {RuleOrLiteral} object
 * @param {boolean} allowDoBlock
 */
function elementReference($, object, allowDoBlock = true) {
  return prec.left(
    1,
    seq(
      field('object', object),
      alias($._element_reference_bracket, '['),
      optional($._argument_list_with_trailing_comma),
      ']',
      optional(field('block', allowDoBlock ? choice($.block, $.do_block) : $.block))
    )
  );
}

/**
 * @param {GrammarSymbols<string>} $
 * @param {RuleOrLiteral} condition
 * @param {RuleOrLiteral} branch
 */
function conditionalExpression($, condition, branch = $._arg) {
  return prec.right(
    PREC.CONDITIONAL,
    seq(field('condition', condition), '?', field('consequence', branch), ':', field('alternative', branch))
  );
}

/**
 * @param {GrammarSymbols<string>} $
 * @param {RuleOrLiteral} begin
 * @param {boolean} allowBeginless
 * @param {RuleOrLiteral} endValue
 */
function rangeExpression($, begin, allowBeginless, endValue = $._arg) {
  const end = field('end', choice(endValue, alias($._range_sign, $.unary)));
  const operator = field('operator', choice('..', '...'));
  // `_no_line_break` never matches; it tells the scanner that the end may follow on the next line.
  const bounded = seq(field('begin', begin), operator, optional(choice(end, $._no_line_break)));
  return prec.right(PREC.RANGE, allowBeginless ? choice(bounded, seq(operator, end)) : bounded);
}

/**
 * @param {GrammarSymbols<string>} $
 * @param {RuleOrLiteral} receiver
 * @param {RuleOrLiteral} argumentsRule
 */
function commandCallWithBlock($, receiver, argumentsRule) {
  const args = field('arguments', alias(argumentsRule, $.argument_list));
  return choice(
    seq(receiver, prec(PREC.CURLY_BLOCK, seq(args, field('block', $.block)))),
    prec.dynamic(1, seq(receiver, prec(PREC.DO_BLOCK, seq(args, field('block', $.do_block)))))
  );
}

/**
 * @param {GrammarSymbols<string>} $
 * @param {RuleOrLiteral} key
 * @param {boolean} allowBlockContinuation
 */
function commandPair($, key, allowBlockContinuation = true) {
  const value = $._arg;
  return prec.dynamic(
    1,
    choice(
      prec.right(PREC.PATTERN, seq(field('key', alias($._super_command, $.call)), '=>', field('value', value))),
      prec.right(
        seq(
          field(
            'key',
            choice(
              alias(key, $.call),
              alias($._super_command_with_block, $.call),
              alias($._yield_pair_key, $.yield),
              alias(allowBlockContinuation ? $._pattern_command_not : $._yield_not, $.unary),
              alias($._chained_assignment, $.assignment),
              alias($._chained_operator_assignment, $.operator_assignment),
              ...(allowBlockContinuation ? [$._chained_arg] : [])
            )
          ),
          '=>',
          field('value', value)
        )
      )
    )
  );
}

/**
 * @param {GrammarSymbols<string>} $
 * @param {RuleOrLiteral} expression
 * @param {RuleOrLiteral} commandPairRule
 */
function argument($, expression, commandPairRule = $._command_pair) {
  return prec.left(
    choice(
      expression,
      $.splat_argument,
      $.hash_splat_argument,
      $.forward_argument,
      $.block_argument,
      $.pair,
      alias(commandPairRule, $.pair),
      alias($._command_definition_pair, $.pair)
    )
  );
}

/**
 * @param {GrammarSymbols<string>} $
 * @param {RuleOrLiteral} rest
 */
function singletonMethod($, rest) {
  return seq(
    'def',
    seq(
      choice(
        field('object', choice($._variable, $.self, $._nonlocal_variable)),
        seq('(', field('object', $._arg), ')')
      ),
      choice('.', '::')
    ),
    rest
  );
}

/**
 * @param {GrammarSymbols<string>} $
 * @param {RuleOrLiteral} body
 */
function endlessMethodRest($, body) {
  return seq(
    field('name', $._method_name),
    optional(field('parameters', alias($.parameters, $.method_parameters))),
    '=',
    field('body', body)
  );
}

/**
 * @param {GrammarSymbols<string>} $
 * @param {RuleOrLiteral} value
 * @param {RuleOrLiteral} rescue
 */
function endlessBody($, value, rescue) {
  return choice(value, alias(rescue, $.rescue_modifier));
}

/**
 * @param {GrammarSymbols<string>} $
 * @param {RuleOrLiteral} value
 */
function endlessBodyRescue($, value) {
  return prec(PREC.RESCUE, seq(field('body', value), 'rescue', field('handler', $._arg)));
}

/**
 * @param {GrammarSymbols<string>} $
 * @param {boolean} allowCall
 */
function yieldPairKeyArguments($, allowCall) {
  return prec.right(
    1,
    seq(
      repeat(seq($._yield_argument, ',')),
      choice(
        $.pair,
        $.splat_argument,
        $.hash_splat_argument,
        alias($._yield_command_pair, $.pair),
        alias($._command_definition_pair, $.pair),
        ...(allowCall ? [alias($._yield_call_pair_key, $.call)] : [])
      )
    )
  );
}

/**
 * @param {GrammarSymbols<string>} $
 * @param {RuleOrLiteral} lhs
 * @param {RuleOrLiteral} call
 * @param {RuleOrLiteral} method
 * @param {RuleOrLiteral} singletonMethod
 */
function primaryExpression($, lhs, call, method, singletonMethod) {
  return choice(
    prec(1, $.super),
    $.parenthesized_statements,
    lhs,
    alias($._function_identifier_call, $.call),
    call,
    $.array,
    $.string_array,
    $.symbol_array,
    $.hash,
    $.subshell,
    $._literal,
    $.string,
    $.character,
    $.chained_string,
    $.regex,
    $.lambda,
    method,
    singletonMethod,
    $.class,
    $.singleton_class,
    $.module,
    $.begin,
    $.while,
    $.until,
    $.if,
    $.unless,
    $.for,
    $.case,
    $.case_match,
    $.return,
    $.yield,
    $.break,
    $.next,
    $.redo,
    $.retry,
    alias($.parenthesized_unary, $.unary),
    $.heredoc_beginning
  );
}

/**
 * @param {GrammarSymbols<string>} $
 * @param {RuleOrLiteral} scopeResolution
 * @param {RuleOrLiteral} elementReference
 * @param {RuleOrLiteral} member
 */
function leftHandSide($, scopeResolution, elementReference, member) {
  return prec.left(
    choice($._variable, $.self, $._nonlocal_variable, $.true, $.false, $.nil, scopeResolution, elementReference, member)
  );
}

/**
 * @param {GrammarSymbols<string>} $
 * @param {RuleOrLiteral} primary
 * @param {RuleOrLiteral} member
 * @param {boolean} allowDoBlock
 */
function callExpression($, primary, member, allowDoBlock = true) {
  const receiver = choice(member, field('method', choice($._variable, $._function_identifier, $.super)));

  const args = field('arguments', $.argument_list);
  const receiverArguments = seq(
    choice(receiver, prec.left(PREC.CALL, seq(field('receiver', primary), field('operator', $._call_operator)))),
    args
  );

  const block = field('block', $.block);
  const doBlock = field('block', $.do_block);
  return choice(
    receiverArguments,
    prec(PREC.CURLY_BLOCK, seq(receiverArguments, block)),
    ...(allowDoBlock ? [prec(PREC.DO_BLOCK, seq(receiverArguments, doBlock))] : []),
    prec(PREC.CURLY_BLOCK, seq(receiver, block)),
    ...(allowDoBlock ? [prec(PREC.DO_BLOCK, seq(receiver, doBlock))] : [])
  );
}

/**
 * @param {GrammarSymbols<string>} $
 * @param {RuleOrLiteral} bodyExpression
 */
function methodRest($, bodyExpression) {
  return seq(
    field('name', $._method_name),
    choice(
      bodyExpression,
      seq(
        field('parameters', alias($.parameters, $.method_parameters)),
        choice(seq(optional($._terminator), optional(field('body', $.body_statement)), 'end'), bodyExpression)
      ),
      seq(
        optional(field('parameters', alias($.bare_parameters, $.method_parameters))),
        $._terminator,
        optional(field('body', $.body_statement)),
        'end'
      )
    )
  );
}

/**
 * @param {GrammarSymbols<string>} $
 * @param {boolean} allowAssignment
 */
function commandValue($, allowAssignment) {
  return choice(
    prec(0, alias($._command_not, $.unary)),
    prec(0, alias($._test_pattern_not, $.unary)),
    alias($._command_method, $.method),
    alias($._command_singleton_method, $.singleton_method),
    ...(allowAssignment
      ? [alias($.command_assignment, $.assignment), alias($.command_operator_assignment, $.operator_assignment)]
      : []),
    alias($.command_call, $.call),
    alias($.command_call_with_block, $.call),
    $._chained_arg,
    ...(allowAssignment
      ? [alias($._chained_assignment, $.assignment), alias($._chained_operator_assignment, $.operator_assignment)]
      : []),
    alias($.return_command, $.return),
    alias($.yield_command, $.yield),
    alias($.break_command, $.break),
    alias($.next_command, $.next),
    $._arg
  );
}

/** @param {GrammarSymbols<string>} $ */
function chainedTestPattern($, allowModifiers = true) {
  return prec.dynamic(
    1,
    seq(
      field(
        'value',
        choice(
          $._chained_arg,
          alias($._pattern_command_assignment, $.assignment),
          alias($._pattern_chained_assignment, $.assignment),
          alias($._chained_operator_assignment, $.operator_assignment),
          alias($.command_operator_assignment, $.operator_assignment),
          alias($.command_call_with_block, $.call),
          alias($._chained_command, $.call),
          alias($._command_method, $.method),
          alias($._command_singleton_method, $.singleton_method),
          alias($._receiver_command, $.call),
          alias($._pattern_command_binary, $.binary),
          alias($.command_unary, $.unary),
          $._command_unary_arg,
          alias($._command_not, $.unary),
          alias($.yield_command, $.yield),
          alias($._super_command, $.call),
          ...(allowModifiers
            ? [$.if_modifier, $.unless_modifier, $.while_modifier, $.until_modifier, $.rescue_modifier]
            : [])
        )
      ),
      'in',
      field('pattern', $._pattern_top_expr_body)
    )
  );
}
