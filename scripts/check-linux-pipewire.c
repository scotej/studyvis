#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef void (*pw_init_fn)(int *, char ***);
typedef void (*pw_deinit_fn)(void);
typedef void *(*pw_loop_new_fn)(const void *);
typedef void (*pw_loop_destroy_fn)(void *);
typedef void *(*pw_context_new_fn)(void *, void *, size_t);
typedef void (*pw_context_destroy_fn)(void *);

static void *required_symbol(void *library, const char *name) {
    dlerror();
    void *symbol = dlsym(library, name);
    const char *error = dlerror();
    if (error != NULL) {
        fprintf(stderr, "PipeWire symbol %s: %s\n", name, error);
        exit(EXIT_FAILURE);
    }
    return symbol;
}

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: %s <libpipewire-0.3.so.0>\n", argv[0]);
        return 2;
    }

    void *library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (library == NULL) {
        fprintf(stderr, "PipeWire dlopen: %s\n", dlerror());
        return 1;
    }

    pw_init_fn init = (pw_init_fn)required_symbol(library, "pw_init");
    pw_deinit_fn deinit = (pw_deinit_fn)required_symbol(library, "pw_deinit");
    pw_loop_new_fn loop_new = (pw_loop_new_fn)required_symbol(library, "pw_loop_new");
    pw_loop_destroy_fn loop_destroy = (pw_loop_destroy_fn)required_symbol(library, "pw_loop_destroy");
    pw_context_new_fn context_new = (pw_context_new_fn)required_symbol(library, "pw_context_new");
    pw_context_destroy_fn context_destroy = (pw_context_destroy_fn)required_symbol(library, "pw_context_destroy");

    init(NULL, NULL);
    void *loop = loop_new(NULL);
    if (loop == NULL) {
        fprintf(stderr, "PipeWire loop: %s\n", strerror(errno));
        deinit();
        dlclose(library);
        return 1;
    }
    puts("Native packaged PipeWire loop created");
    fflush(stdout);

    void *context = context_new(loop, NULL, 0);
    if (context == NULL) {
        fprintf(stderr, "PipeWire context: %s\n", strerror(errno));
        loop_destroy(loop);
        deinit();
        dlclose(library);
        return 1;
    }
    puts("Native packaged PipeWire context created");
    fflush(stdout);

    context_destroy(context);
    loop_destroy(loop);
    deinit();
    dlclose(library);
    puts("Native packaged PipeWire context and loop destroyed");
    return 0;
}
