/* The published scanner uses calloc directly, so it shares the checked allocator. */
#define PARSER_ALLOCATOR_REPLACE
#include "allocator.h"
#include "vendor/tree-sitter-luau/src/scanner.c"
