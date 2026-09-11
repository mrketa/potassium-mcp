#ifndef POTASSIUM_PARSER_ALLOCATOR_H
#define POTASSIUM_PARSER_ALLOCATOR_H

#include <stddef.h>
#include <stdlib.h>

/* All runtime/scanner allocation is bounded and fails before emitting a tree. */
void *parser_malloc(size_t size);
void *parser_calloc(size_t count, size_t size);
void *parser_realloc(void *pointer, size_t size);
void parser_free(void *pointer);

#ifdef PARSER_ALLOCATOR_REPLACE
#define malloc parser_malloc
#define calloc parser_calloc
#define realloc parser_realloc
#define free parser_free
#endif

#endif
