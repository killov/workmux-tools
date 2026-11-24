// GENERATED from craft-common/meminfo.c by craft-common/sync.mjs — do not edit, run the sync instead.
// Preloaded into the container (/etc/ld.so.preload): /proc/meminfo with MemTotal capped by the memory cgroup.
//
// The Craft engines keep a headroom of 5% of MemTotal outside their working memory, but MemTotal is the host's
// RAM while the memory they may use is the container's cgroup limit. On a large host that headroom exceeds the
// whole limit and every filter fails with "not enough working memory". The other fields stay the host's; the
// engines cap MemAvailable by the cgroup themselves.

#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

// cgroup v2, then v1. "max" (v2) does not parse and v1's "unlimited" exceeds MemTotal: both leave it as is.
static unsigned long long cgroup_limit_kb(void) {
  static const char *const files[] = {"/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"};
  for (size_t i = 0; i < sizeof files / sizeof *files; i++) {
    FILE *f = fopen(files[i], "re");
    if (!f) continue;
    unsigned long long bytes;
    int ok = fscanf(f, "%llu", &bytes) == 1;
    fclose(f);
    if (ok) return bytes / 1024;
  }
  return 0;
}

// An in-memory copy of /proc/meminfo with the capped MemTotal, or -1 to read the real file.
static int capped_meminfo(int flags) {
  unsigned long long limit = cgroup_limit_kb();
  if (!limit) return -1;
  FILE *in = fopen("/proc/meminfo", "re");
  if (!in) return -1;
  int fd = memfd_create("meminfo", (flags & O_CLOEXEC) ? MFD_CLOEXEC : 0);
  FILE *out = fd < 0 ? NULL : fdopen(dup(fd), "w");
  if (!out) {
    fclose(in);
    if (fd >= 0) close(fd);
    return -1;
  }
  char line[256];
  unsigned long long kb;
  while (fgets(line, sizeof line, in)) {
    if (sscanf(line, "MemTotal: %llu kB", &kb) == 1 && limit < kb) fprintf(out, "MemTotal:       %llu kB\n", limit);
    else fputs(line, out);
  }
  fclose(in);
  fclose(out);
  lseek(fd, 0, SEEK_SET);
  return fd;
}

// Rust's std::fs (the engines and sysinfo) opens files through open64; glibc's own fopen above does not.
int open64(const char *path, int flags, ...) {
  static int (*real_open64)(const char *, int, ...);
  if (!real_open64) real_open64 = (int (*)(const char *, int, ...))dlsym(RTLD_NEXT, "open64");
  mode_t mode = 0;
  if ((flags & O_CREAT) || (flags & O_TMPFILE) == O_TMPFILE) {
    va_list ap;
    va_start(ap, flags);
    mode = va_arg(ap, mode_t);
    va_end(ap);
  }
  if (strcmp(path, "/proc/meminfo") == 0) {
    int fd = capped_meminfo(flags);
    if (fd >= 0) return fd;
  }
  return real_open64(path, flags, mode);
}
