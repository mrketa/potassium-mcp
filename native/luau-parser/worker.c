#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <windows.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include "allocator.h"
#include "tree_sitter/api.h"

#define MAX_MODULES 32u
#define MAX_SOURCE_BYTES 262144u
#define MAX_INPUT_BYTES 4194304u
#define MAX_NODES 200000u
#define MAX_DEPTH 512u
#define MAX_OUTPUT_BYTES 8388608u
#define MAX_ALLOCATION_BYTES (192u * 1024u * 1024u)
#define NONE UINT32_MAX

extern const TSLanguage *tree_sitter_luau(void);

static bool write_all(HANDLE handle, const void *data, size_t size) {
    const unsigned char *bytes = data;
    while (size) {
        DWORD written = 0;
        DWORD chunk = size > 65536u ? 65536u : (DWORD)size;
        if (!WriteFile(handle, bytes, chunk, &written, NULL) || !written) return false;
        bytes += written;
        size -= written;
    }
    return true;
}

static _Noreturn void fail(const char *code, const char *message) {
    /* Callers pass fixed ASCII literals, never input or grammar text. */
    char result[512];
    const char *parts[] = {"{\"schema\":1,\"error\":{\"code\":\"", code,
        "\",\"message\":\"", message, "\"}}\n"};
    size_t used = 0;
    for (size_t i = 0; i < sizeof(parts) / sizeof(parts[0]); ++i) {
        size_t length = strlen(parts[i]);
        if (length > sizeof(result) - used) ExitProcess(2);
        memcpy(result + used, parts[i], length);
        used += length;
    }
    write_all(GetStdHandle(STD_OUTPUT_HANDLE), result, used);
    ExitProcess(2);
}

typedef union AllocationHeader {
    size_t size;
    max_align_t alignment;
} AllocationHeader;
static size_t allocated_bytes;

void *parser_malloc(size_t size) {
    if (!size) size = 1;
    if (size > MAX_ALLOCATION_BYTES - sizeof(AllocationHeader) ||
        size + sizeof(AllocationHeader) > MAX_ALLOCATION_BYTES - allocated_bytes)
        fail("memory_limit", "Native parser allocation limit exceeded");
    AllocationHeader *header = HeapAlloc(GetProcessHeap(), 0, sizeof(*header) + size);
    if (!header) fail("memory_limit", "Native parser allocation failed");
    header->size = size;
    allocated_bytes += sizeof(*header) + size;
    return header + 1;
}

void parser_free(void *pointer) {
    if (!pointer) return;
    AllocationHeader *header = (AllocationHeader *)pointer - 1;
    allocated_bytes -= sizeof(*header) + header->size;
    HeapFree(GetProcessHeap(), 0, header);
}

void *parser_calloc(size_t count, size_t size) {
    if (count && size > SIZE_MAX / count) fail("memory_limit", "Native parser allocation overflow");
    size_t bytes = count * size;
    void *pointer = parser_malloc(bytes);
    memset(pointer, 0, bytes);
    return pointer;
}

void *parser_realloc(void *pointer, size_t size) {
    if (!pointer) return parser_malloc(size);
    if (!size) { parser_free(pointer); return NULL; }
    AllocationHeader *old = (AllocationHeader *)pointer - 1;
    size_t remaining = allocated_bytes - sizeof(*old) - old->size;
    if (size > MAX_ALLOCATION_BYTES - sizeof(*old) ||
        size + sizeof(*old) > MAX_ALLOCATION_BYTES - remaining)
        fail("memory_limit", "Native parser allocation limit exceeded");
    AllocationHeader *header = HeapReAlloc(GetProcessHeap(), 0, old, sizeof(*old) + size);
    if (!header) fail("memory_limit", "Native parser allocation failed");
    header->size = size;
    allocated_bytes = remaining + sizeof(*header) + size;
    return header + 1;
}

static void read_exact(void *data, uint32_t size) {
    unsigned char *bytes = data;
    while (size) {
        DWORD count = 0;
        if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), bytes, size, &count, NULL) || !count)
            fail("invalid_input", "Native parser input frame is incomplete");
        bytes += count;
        size -= count;
    }
}

static uint32_t read_u32(void) {
    unsigned char bytes[4];
    read_exact(bytes, sizeof(bytes));
    return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8) |
        ((uint32_t)bytes[2] << 16) | ((uint32_t)bytes[3] << 24);
}

static void read_magic(const char *expected) {
    char magic[8];
    read_exact(magic, sizeof(magic));
    if (memcmp(magic, expected, sizeof(magic))) fail("invalid_input", "Native parser input magic is invalid");
}

static void require_eof(void) {
    unsigned char byte;
    DWORD count = 0;
    if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), &byte, 1, &count, NULL)) {
        if (GetLastError() == ERROR_BROKEN_PIPE) return;
        fail("invalid_input", "Native parser input stream failed");
    }
    if (count) fail("invalid_input", "Native parser input has trailing bytes");
}

static bool valid_utf8(const unsigned char *bytes, uint32_t size) {
    uint32_t i = 0;
    while (i < size) {
        uint32_t first = bytes[i++], value, following, minimum;
        if (first < 0x80) continue;
        if (first >= 0xc2 && first <= 0xdf) { value = first & 0x1f; following = 1; minimum = 0x80; }
        else if (first >= 0xe0 && first <= 0xef) { value = first & 0x0f; following = 2; minimum = 0x800; }
        else if (first >= 0xf0 && first <= 0xf4) { value = first & 7; following = 3; minimum = 0x10000; }
        else return false;
        if (following > size - i) return false;
        while (following--) {
            uint32_t next = bytes[i++];
            if ((next & 0xc0) != 0x80) return false;
            value = (value << 6) | (next & 0x3f);
        }
        if (value < minimum || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return false;
    }
    return true;
}

typedef struct { char *bytes; size_t length; size_t capacity; } Output;

static void append_bytes(Output *out, const char *bytes, size_t size) {
    if (size > MAX_OUTPUT_BYTES - out->length) fail("output_limit", "Native parser output limit exceeded");
    size_t required = out->length + size;
    if (required > out->capacity) {
        size_t capacity = out->capacity ? out->capacity : 4096;
        while (capacity < required) capacity = capacity > MAX_OUTPUT_BYTES / 2 ? MAX_OUTPUT_BYTES : capacity * 2;
        out->bytes = parser_realloc(out->bytes, capacity);
        out->capacity = capacity;
    }
    memcpy(out->bytes + out->length, bytes, size);
    out->length = required;
}

static void append(Output *out, const char *text) { append_bytes(out, text, strlen(text)); }
static void number(Output *out, uint32_t value) {
    char digits[10];
    size_t length = 0;
    do { digits[sizeof(digits) - ++length] = (char)('0' + value % 10); value /= 10; } while (value);
    append_bytes(out, digits + sizeof(digits) - length, length);
}
static void boolean(Output *out, bool value) { append(out, value ? "true" : "false"); }

static void string(Output *out, const char *value) {
    static const char hex[] = "0123456789abcdef";
    if (!value) fail("parser_failure", "Native parser returned invalid symbol metadata");
    append(out, "\"");
    for (const unsigned char *p = (const unsigned char *)value; *p; ++p) {
        if (*p == '"' || *p == '\\') {
            char escaped[2] = {'\\', (char)*p};
            append_bytes(out, escaped, sizeof(escaped));
        } else if (*p < 0x20) {
            char escaped[6] = {'\\', 'u', '0', '0', hex[*p >> 4], hex[*p & 15]};
            append_bytes(out, escaped, sizeof(escaped));
        } else append_bytes(out, (const char *)p, 1);
    }
    append(out, "\"");
}

typedef struct {
    TSNode node;
    uint32_t first_child, last_child, next_sibling;
    TSFieldId field;
} Node;

static uint32_t flatten(TSNode root, Node **storage, uint32_t *capacity, uint32_t *total_nodes) {
    uint32_t parents[MAX_DEPTH + 1], depth = 0, count = 0;
    TSTreeCursor cursor = ts_tree_cursor_new(root);
    for (;;) {
        if (depth > MAX_DEPTH) fail("depth_limit", "Native parser syntax depth limit exceeded");
        if (*total_nodes == MAX_NODES) fail("node_limit", "Native parser node limit exceeded");
        if (count == *capacity) {
            uint32_t next = *capacity ? *capacity * 2 : 1024;
            if (next > MAX_NODES) next = MAX_NODES;
            *storage = parser_realloc(*storage, (size_t)next * sizeof(Node));
            *capacity = next;
        }
        uint32_t id = count++;
        ++*total_nodes;
        Node *nodes = *storage;
        nodes[id] = (Node){ts_tree_cursor_current_node(&cursor), NONE, NONE, NONE,
            depth ? ts_tree_cursor_current_field_id(&cursor) : 0};
        if (depth) {
            Node *parent = &nodes[parents[depth - 1]];
            if (parent->last_child != NONE) nodes[parent->last_child].next_sibling = id;
            else parent->first_child = id;
            parent->last_child = id;
        }
        parents[depth] = id;
        if (ts_tree_cursor_goto_first_child(&cursor)) { ++depth; continue; }
        while (!ts_tree_cursor_goto_next_sibling(&cursor)) {
            if (!depth) { ts_tree_cursor_delete(&cursor); return count; }
            if (!ts_tree_cursor_goto_parent(&cursor)) fail("parser_failure", "Native parser cursor lost its parent");
            --depth;
        }
    }
}

static void emit_tree(Output *out, Node *nodes, uint32_t count, const TSLanguage *language) {
    uint32_t field_count = ts_language_field_count(language);
    if (field_count > 255) fail("parser_failure", "Native parser field inventory is unsupported");
    append(out, "{\"root\":0,\"nodes\":[");
    for (uint32_t i = 0; i < count; ++i) {
        Node *row = &nodes[i];
        TSNode node = row->node;
        TSPoint start = ts_node_start_point(node), end = ts_node_end_point(node);
        if (i) append(out, ",");
        append(out, "{\"type\":"); string(out, ts_node_type(node));
        append(out, ",\"startByte\":"); number(out, ts_node_start_byte(node));
        append(out, ",\"endByte\":"); number(out, ts_node_end_byte(node));
        append(out, ",\"startRow\":"); number(out, start.row);
        append(out, ",\"startByteColumn\":"); number(out, start.column);
        append(out, ",\"endRow\":"); number(out, end.row);
        append(out, ",\"endByteColumn\":"); number(out, end.column);
        append(out, ",\"named\":"); boolean(out, ts_node_is_named(node));
        append(out, ",\"missing\":"); boolean(out, ts_node_is_missing(node));
        append(out, ",\"hasError\":"); boolean(out, ts_node_has_error(node));
        append(out, ",\"children\":[");
        for (uint32_t child = row->first_child; child != NONE; child = nodes[child].next_sibling) {
            if (child != row->first_child) append(out, ",");
            number(out, child);
        }
        append(out, "],\"fields\":{");
        bool seen[256] = {false}, any_field = false;
        for (uint32_t child = row->first_child; child != NONE; child = nodes[child].next_sibling) {
            TSFieldId field = nodes[child].field;
            if (field > field_count) fail("parser_failure", "Native parser returned an invalid field");
            if (!field || seen[field]) continue;
            seen[field] = true;
            if (any_field) append(out, ",");
            any_field = true;
            string(out, ts_language_field_name_for_id(language, field));
            append(out, ":[");
            bool any_child = false;
            for (uint32_t member = child; member != NONE; member = nodes[member].next_sibling) {
                if (nodes[member].field != field) continue;
                if (any_child) append(out, ",");
                any_child = true;
                number(out, member);
            }
            append(out, "]");
        }
        append(out, "}}");
    }
    append(out, "]}");
}

static int parse_input(void) {
    read_magic("PMCPAST1");
    uint32_t module_count = read_u32(), input_bytes = 0, total_nodes = 0, capacity = 0;
    if (!module_count || module_count > MAX_MODULES) fail("input_limit", "Native parser module count is out of bounds");
    const TSLanguage *language = tree_sitter_luau();
    TSParser *parser = ts_parser_new();
    if (!parser || !ts_parser_set_language(parser, language)) fail("parser_failure", "Native parser grammar ABI is unsupported");
    Output out = {0};
    Node *nodes = NULL;
    append(&out, "{\"schema\":1,\"parser\":{\"runtime\":\"tree-sitter\",\"runtimeVersion\":\"0.25.0\",\"grammar\":\"tree-sitter-luau\",\"grammarVersion\":\"1.2.0\"},\"trees\":[");
    for (uint32_t i = 0; i < module_count; ++i) {
        uint32_t size = read_u32();
        if (size > MAX_SOURCE_BYTES || size > MAX_INPUT_BYTES - input_bytes)
            fail("input_limit", "Native parser source byte limit exceeded");
        input_bytes += size;
        char *source = parser_malloc((size_t)size + 1);
        read_exact(source, size);
        source[size] = '\0';
        if (!valid_utf8((const unsigned char *)source, size)) fail("invalid_input", "Native parser source is not valid UTF-8");
        TSTree *tree = ts_parser_parse_string(parser, NULL, source, size);
        if (!tree) fail("parser_failure", "Native parser did not produce a syntax tree");
        TSNode root = ts_tree_root_node(tree);
        if (ts_node_is_null(root)) fail("parser_failure", "Native parser did not produce a root node");
        uint32_t count = flatten(root, &nodes, &capacity, &total_nodes);
        if (i) append(&out, ",");
        emit_tree(&out, nodes, count, language);
        ts_tree_delete(tree);
        ts_parser_reset(parser);
        parser_free(source);
    }
    require_eof();
    append(&out, "],\"truncated\":false}\n");
    ts_parser_delete(parser);
    parser_free(nodes);
    bool written = write_all(GetStdHandle(STD_OUTPUT_HANDLE), out.bytes, out.length);
    parser_free(out.bytes);
    return written ? 0 : 3;
}

typedef struct { bool attempted, allowed; DWORD error; } Attempt;
static Attempt read_probe_file(const wchar_t *path) {
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return (Attempt){true, false, GetLastError()};
    unsigned char byte;
    DWORD count = 0;
    bool allowed = ReadFile(file, &byte, 1, &count, NULL) != FALSE;
    DWORD error = allowed ? ERROR_SUCCESS : GetLastError();
    CloseHandle(file);
    return (Attempt){true, allowed, error};
}

static Attempt write_probe_file(void) {
    HANDLE file = CreateFileW(L"probe-write.tmp", GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return (Attempt){true, false, GetLastError()};
    DWORD count = 0;
    bool allowed = WriteFile(file, "x", 1, &count, NULL) && count == 1;
    DWORD error = allowed ? ERROR_SUCCESS : GetLastError();
    CloseHandle(file);
    DeleteFileW(L"probe-write.tmp");
    return (Attempt){true, allowed, error};
}

static Attempt process_probe(void) {
    wchar_t executable[32768], command[32768];
    DWORD length = GetModuleFileNameW(NULL, executable, 32768);
    if (!length || length >= 32750) return (Attempt){false, false, length ? ERROR_BUFFER_OVERFLOW : GetLastError()};
    command[0] = L'"';
    memcpy(command + 1, executable, length * sizeof(wchar_t));
    static const wchar_t suffix[] = L"\" --probe child";
    memcpy(command + length + 1, suffix, sizeof(suffix));
    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION process = {0};
    startup.cb = sizeof(startup);
    bool allowed = CreateProcessW(executable, command, NULL, NULL, FALSE,
        CREATE_SUSPENDED | CREATE_NO_WINDOW, NULL, NULL, &startup, &process) != FALSE;
    DWORD error = allowed ? ERROR_SUCCESS : GetLastError();
    if (allowed) {
        TerminateProcess(process.hProcess, 0);
        WaitForSingleObject(process.hProcess, 1000);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
    return (Attempt){true, allowed, error};
}

typedef struct {
    bool available, attempted, allowed;
    DWORD error;
    const char *phase;
} NetworkAttempt;

static NetworkAttempt network_probe(uint16_t port) {
    HMODULE library = LoadLibraryExW(L"ws2_32.dll", NULL, LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!library) return (NetworkAttempt){false, false, false, GetLastError(), "load"};
    typedef int (WSAAPI *Startup)(WORD, LPWSADATA);
    typedef int (WSAAPI *Cleanup)(void);
    typedef SOCKET (WSAAPI *OpenSocket)(int, int, int);
    typedef int (WSAAPI *CloseSocket)(SOCKET);
    typedef int (WSAAPI *Connect)(SOCKET, const struct sockaddr *, int);
    typedef int (WSAAPI *LastError)(void);
    typedef int (WSAAPI *Ioctl)(SOCKET, long, u_long *);
    typedef int (WSAAPI *Select)(int, fd_set *, fd_set *, fd_set *, const struct timeval *);
    typedef int (WSAAPI *GetOption)(SOCKET, int, int, char *, int *);
    Startup startup = (Startup)GetProcAddress(library, "WSAStartup");
    Cleanup cleanup = (Cleanup)GetProcAddress(library, "WSACleanup");
    OpenSocket open_socket = (OpenSocket)GetProcAddress(library, "socket");
    CloseSocket close_socket = (CloseSocket)GetProcAddress(library, "closesocket");
    Connect connect_socket = (Connect)GetProcAddress(library, "connect");
    LastError last_error = (LastError)GetProcAddress(library, "WSAGetLastError");
    Ioctl ioctl_socket = (Ioctl)GetProcAddress(library, "ioctlsocket");
    Select select_socket = (Select)GetProcAddress(library, "select");
    GetOption get_option = (GetOption)GetProcAddress(library, "getsockopt");
    NetworkAttempt result = {false, false, false, ERROR_PROC_NOT_FOUND, "symbols"};
    if (!startup || !cleanup || !open_socket || !close_socket || !connect_socket ||
        !last_error || !ioctl_socket || !select_socket || !get_option) goto unload;
    WSADATA data;
    int error = startup(MAKEWORD(2, 2), &data);
    if (error) { result.error = (DWORD)error; result.phase = "startup"; goto unload; }
    result.available = true;
    result.attempted = true;
    SOCKET socket = open_socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (socket == INVALID_SOCKET) {
        result.error = (DWORD)last_error(); result.phase = "socket"; goto cleanup;
    }
    u_long nonblocking = 1;
    if (ioctl_socket(socket, FIONBIO, &nonblocking) == SOCKET_ERROR) {
        result.error = (DWORD)last_error(); result.phase = "nonblocking"; goto close;
    }
    struct sockaddr_in address = {0};
    address.sin_family = AF_INET;
    address.sin_port = (uint16_t)((port << 8) | (port >> 8));
    address.sin_addr.s_addr = 0x0100007fu; /* Windows x64 little-endian 127.0.0.1. */
    result.phase = "connect";
    error = connect_socket(socket, (const struct sockaddr *)&address, sizeof(address));
    if (!error) { result.allowed = true; result.error = 0; goto close; }
    result.error = (DWORD)last_error();
    if (result.error == WSAEWOULDBLOCK) {
        fd_set writable = {0}, exceptional = {0};
        writable.fd_count = exceptional.fd_count = 1;
        writable.fd_array[0] = exceptional.fd_array[0] = socket;
        struct timeval timeout = {2, 0};
        int ready = select_socket(0, NULL, &writable, &exceptional, &timeout);
        if (ready == SOCKET_ERROR) result.error = (DWORD)last_error();
        else if (!ready) result.error = WSAETIMEDOUT;
        else {
            int socket_error = 0, size = sizeof(socket_error);
            if (get_option(socket, SOL_SOCKET, SO_ERROR, (char *)&socket_error, &size) == SOCKET_ERROR)
                result.error = (DWORD)last_error();
            else { result.error = (DWORD)socket_error; result.allowed = socket_error == 0; }
        }
    }
close:
    close_socket(socket);
cleanup:
    cleanup();
unload:
    FreeLibrary(library);
    return result;
}

static void emit_attempt(Output *out, Attempt result) {
    append(out, "{\"attempted\":"); boolean(out, result.attempted);
    append(out, ",\"allowed\":");
    if (result.attempted) boolean(out, result.allowed); else append(out, "null");
    append(out, ",\"error\":"); number(out, result.error);
    append(out, "}");
}

static bool environment_present(const wchar_t *name) {
    SetLastError(ERROR_SUCCESS);
    DWORD size = GetEnvironmentVariableW(name, NULL, 0);
    return size != 0 || GetLastError() != ERROR_ENVVAR_NOT_FOUND;
}

static int denial_probe(void) {
    read_magic("PMCPPRB1");
    uint32_t count = read_u32();
    if (!count || count > 8) fail("invalid_probe", "Native denial probe path count is invalid");
    wchar_t paths[8][4097];
    for (uint32_t i = 0; i < count; ++i) {
        uint32_t size = read_u32();
        if (!size || size > 4096) fail("invalid_probe", "Native denial probe path length is invalid");
        char source[4096];
        read_exact(source, size);
        if (memchr(source, '\0', size)) fail("invalid_probe", "Native denial probe path contains NUL");
        int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, source, (int)size, paths[i], 4096);
        if (!length) fail("invalid_probe", "Native denial probe path is not valid UTF-8");
        paths[i][length] = L'\0';
    }
    uint32_t port = read_u32();
    if (!port || port > 65535) fail("invalid_probe", "Native denial probe port is invalid");
    require_eof();
    Output out = {0};
    append(&out, "{\"schema\":1,\"probe\":\"denials\",\"files\":[");
    for (uint32_t i = 0; i < count; ++i) {
        if (i) append(&out, ",");
        emit_attempt(&out, read_probe_file(paths[i]));
    }
    append(&out, "],\"stageWrite\":"); emit_attempt(&out, write_probe_file());
    append(&out, ",\"process\":"); emit_attempt(&out, process_probe());
    NetworkAttempt network = network_probe((uint16_t)port);
    append(&out, ",\"network\":{\"available\":"); boolean(&out, network.available);
    append(&out, ",\"attempted\":"); boolean(&out, network.attempted);
    append(&out, ",\"allowed\":");
    if (network.attempted) boolean(&out, network.allowed); else append(&out, "null");
    append(&out, ",\"error\":"); number(&out, network.error);
    append(&out, ",\"phase\":"); string(&out, network.phase);
    append(&out, "},\"environment\":{\"PARSER_PROBE_TOKEN\":"); boolean(&out, environment_present(L"PARSER_PROBE_TOKEN"));
    append(&out, ",\"NODE_OPTIONS\":"); boolean(&out, environment_present(L"NODE_OPTIONS"));
    append(&out, ",\"DOTNET_STARTUP_HOOKS\":"); boolean(&out, environment_present(L"DOTNET_STARTUP_HOOKS"));
    append(&out, "}}\n");
    bool written = write_all(GetStdHandle(STD_OUTPUT_HANDLE), out.bytes, out.length);
    parser_free(out.bytes);
    return written ? 0 : 3;
}

static int probe(const char *mode) {
    if (strcmp(mode, "denials") && strcmp(mode, "cpu") && strcmp(mode, "memory") &&
        strcmp(mode, "stdout") && strcmp(mode, "wall") && strcmp(mode, "child"))
        fail("invalid_probe", "Native probe mode is not supported");
    static const char marker[] = "parser-probe-running\n";
    if (!write_all(GetStdHandle(STD_ERROR_HANDLE), marker, sizeof(marker) - 1)) return 3;
    if (!strcmp(mode, "denials")) return denial_probe();
    if (!strcmp(mode, "child")) return 0;
    require_eof();
    if (!strcmp(mode, "cpu")) {
        volatile uint64_t value = 1;
        ULONGLONG deadline = GetTickCount64() + 60000;
        do {
            for (uint32_t i = 0; i < 65536; ++i) value = value * UINT64_C(6364136223846793005) + 1;
        } while (GetTickCount64() < deadline);
        fail("probe_unenforced", "Native CPU probe exceeded its safety deadline");
    }
    if (!strcmp(mode, "memory")) {
        uint32_t allocated = 0;
        while (allocated < 512u * 1024u * 1024u) {
            volatile unsigned char *memory = VirtualAlloc(NULL, 1024u * 1024u, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
            if (!memory) {
                DWORD error = GetLastError();
                Output evidence = {0};
                append(&evidence, "parser-probe-memory-allocation-denied:"); number(&evidence, error);
                append(&evidence, ":"); number(&evidence, allocated); append(&evidence, "\n");
                write_all(GetStdHandle(STD_ERROR_HANDLE), evidence.bytes, evidence.length);
                evidence.length = 0;
                append(&evidence, "{\"schema\":1,\"probe\":\"memory\",\"allocation\":");
                emit_attempt(&evidence, (Attempt){true, false, error});
                append(&evidence, ",\"allocatedBytes\":"); number(&evidence, allocated);
                append(&evidence, "}\n");
                write_all(GetStdHandle(STD_OUTPUT_HANDLE), evidence.bytes, evidence.length);
                parser_free(evidence.bytes);
                return 3;
            }
            for (size_t i = 0; i < 1024u * 1024u; i += 4096) memory[i] = 0x5a;
            allocated += 1024u * 1024u;
        }
        fail("probe_unenforced", "Native memory probe exceeded its safety allocation limit");
    }
    if (!strcmp(mode, "stdout")) {
        char bytes[65536]; memset(bytes, 'x', sizeof(bytes));
        for (uint32_t i = 0; i < 256; ++i)
            if (!write_all(GetStdHandle(STD_OUTPUT_HANDLE), bytes, sizeof(bytes))) return 3;
        return 4;
    }
    Sleep(60000);
    fail("probe_unenforced", "Native wall probe exceeded its safety deadline");
}

int main(int argc, char **argv) {
    if (argc == 1) return parse_input();
    if (argc == 3 && !strcmp(argv[1], "--probe")) return probe(argv[2]);
    fail("invalid_input", "Native parser accepts only framed input or fixed probe modes");
}
