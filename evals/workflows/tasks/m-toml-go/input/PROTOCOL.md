# The toml-test protocol

From `toml-test test -help` (toml-test v2.2.0, MIT, https://github.com/toml-lang/toml-test). Your
`cmd/toml-decoder` and `cmd/toml-encoder` must follow it for TOML 1.0.

```
The "test" command runs the test cases.

The way toml-test works is that for every test case it executes a "decoder"
command, which reads TOML from stdin and then outputs JSON describing that TOML
(or returns an error if it thinks the TOML isn't valid). Encoder tests work the
same except in reverse: it reads JSON and transforms that to TOML.

There are three types of tests:

    valid      Valid TOML that the decoder command should describe as JSON.
    invalid    Invalid TOML files that should be rejected with an error.
    encoder    JSON that the encoder command should transform to TOML.

Implementing a decoder:

    A decoder reads TOML data from stdin and outputs a JSON description to
    stdout and exits with code 0. If the TOML data is invalid, it must exit
    with code 1. It's recommended to write an error message to stderr.

    An example in pseudocode:

        toml_data = read_stdin()

        parsed_toml = decode_toml(toml_data)

        if error_parsing_toml():
            print_error_to_stderr()
            exit(1)

        print_as_json_description(parsed_toml)
        exit(0)

    Details of the JSON format is explained below in "JSON description".

Implementing an encoder:

    An encoder is the reverse of a decoder; it reads a JSON description from
    stdin converts that to TOML.

    An example in pseudocode:

        json_data = read_stdin()

        json_description = decode_json(json_data)

        print_as_toml(json_description)
        exit(0)

JSON description

    TOML is described with JSON as follows:

    - TOML tables correspond to JSON objects.
    - TOML arrays correspond to JSON arrays.
    - TOML values correspond to a JSON object of the form:
      {"type": "{TOML_TYPE}", "value": "{TOML_VALUE}"}

    In the above, TOML_VALUE is always a JSON string (even for integers or
    bools), and TOML_TYPE may be one of: string, integer, float, bool,
    datetime, datetime-local, date-local, or time-local.

    Empty tables correspond to empty JSON objects ({}) and empty arrays
    correspond to empty JSON arrays ([]).

    Offset datetimes should be encoded in RFC 3339; Local datetimes should be
    encoded following RFC 3339 without the offset part. Local dates should be
    encoded as the date part of RFC 3339 and local times as the time part.

    Examples:

        ┌───────────────┬────────────────────────────────────────────────────┐
        │ TOML          │ JSON                                               │
        ├───────────────┼────────────────────────────────────────────────────┤
        │ a = 42        │   {"type": "integer", "value": "42"}               │
        ├───────────────┼────────────────────────────────────────────────────┤
        │ [tbl]         │   {"tbl": {                                        │
        │ a = 42        │       "a": {"type": "integer", "value": "42"}      │
        │               │   }}                                               │
        ├───────────────┼────────────────────────────────────────────────────┤
        │ a = ["a", 2]  │   {"a": [                                          │
        │               │       {"type": "string",  "value": "a"},           │
        │               │       {"type": "integer", "value": "2"}            │
        │               │   ]}                                               │
        ├───────────────┼────────────────────────────────────────────────────┤
        │ [[arr]]       │   {"arr": [                                        │
        │ a = 1         │       {                                            │
        │ b = 2         │           "a": {"type": "integer", "value": "1"},  │
        │ [[arr]]       │           "b": {"type": "integer", "value": "2"}   │
        │ a = 3         │       }, {                                         │
        │ b = 4         │           "a": {"type": "integer", "value": "3"},  │
        │               │           "b": {"type": "integer", "value": "4"}   │
        │               │       }                                            │
        │               │   ]}                                               │
        └───────────────┴────────────────────────────────────────────────────┘
```
