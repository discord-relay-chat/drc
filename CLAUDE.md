# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build/Test/Lint Commands
- Run lint: `npm run lint` (semistandard with --fix and --verbose flags)

## Code Style Guidelines
- **Style**: Uses 'semistandard' (Standard JS with semicolons)
- **Imports**: CommonJS using `require()` not ES modules
- **Exports**: Uses `module.exports = {}` pattern 
- **Naming**: camelCase for variables/functions, UPPERCASE for constants
- **Error Handling**: Custom error classes in lib/Errors.js, consistent try/catch
- **Comments**: Use comments sparingly. Only ever write comments when the reason for the code isn't clear, e.g. only comment on the "why", not the "what". Never write comments that just say in prose what the code clearly says.
- **Async**: Uses async/await pattern over callbacks
- **Formatting**: Semicolons required, consistent indentation with 2 spaces
- **Iteration**: Always prefer the Array iterative methods (map, reduce, filter, etc) over bare `for` loops

When modifying code, maintain existing patterns in the file and follow the semistandard style guide.