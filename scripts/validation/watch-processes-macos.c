// macOS counterpart of watch-processes.ps1 (validation only; never shipped).
// Records which FPGA-tool processes run while a validation phase is active:
// every (pid, executable) pair seen, so a bash wrapper and the program it
// execs are both recorded, with the full argument vector. Polls the process
// table every 2 ms (no root needed) until <stop file> exists.
//
//   clang -O2 -o <scratch>/watch-processes scripts/validation/watch-processes-macos.c
//   <scratch>/watch-processes <out.jsonl> <stop file> [all]
// With "all", every new (pid, executable) pair is recorded (not only FPGA-tool
// names), so the analysis can follow the complete process tree of one VS Code
// instance and attribute every program it started.
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <time.h>
#include <unistd.h>

#define TABLE (1 << 22)
static const char *WATCH[] = {"ghdl", "apio", "yosys", "nextpnr", "python", "fasm", "xc7", "bitread", "bbasm", "openfpgaloader", "iverilog", "nexysvhdl", "decoy", "pip", NULL};
static unsigned long long seen[TABLE];
static int nseen;

/** Adds k to the open-addressing set; returns 1 if it was already there. */
static int remember(unsigned long long k) {
    if (k == 0) k = 1;
    for (unsigned long long i = k & (TABLE - 1);; i = (i + 1) & (TABLE - 1)) {
        if (seen[i] == k) return 1;
        if (seen[i] == 0) {
            if (nseen >= TABLE / 2) return 1;
            seen[i] = k;
            nseen++;
            return 0;
        }
    }
}

static unsigned long long key(pid_t pid, const char *path) {
    unsigned long long h = 1469598103934665603ULL ^ (unsigned long long)pid;
    for (const char *p = path; *p; p++) h = (h ^ (unsigned char)*p) * 1099511628211ULL;
    return h;
}

static int watched(const char *s) {
    for (int i = 0; WATCH[i]; i++) if (strcasestr(s, WATCH[i])) return 1;
    return 0;
}

static void json(FILE *f, const char *s) {
    fputc('"', f);
    for (; *s; s++) {
        if (*s == '"' || *s == '\\') fprintf(f, "\\%c", *s);
        else if ((unsigned char)*s < 0x20) fprintf(f, "\\u%04x", *s);
        else fputc(*s, f);
    }
    fputc('"', f);
}

/** argv joined by spaces (KERN_PROCARGS2: argc, exec path, padding, argv...). */
static void args(pid_t pid, char *out, size_t cap) {
    static char buf[1 << 18];
    int mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
    size_t size = sizeof(buf);
    out[0] = 0;
    if (sysctl(mib, 3, buf, &size, NULL, 0) != 0 || size < sizeof(int)) return;
    int argc;
    memcpy(&argc, buf, sizeof(int));
    char *p = buf + sizeof(int), *end = buf + size;
    p += strnlen(p, end - p);
    while (p < end && *p == 0) p++;
    size_t n = 0;
    for (int i = 0; i < argc && p < end; i++) {
        size_t len = strnlen(p, end - p);
        if (n + len + 2 >= cap) break;
        if (n) out[n++] = ' ';
        memcpy(out + n, p, len);
        n += len;
        out[n] = 0;
        p += len + 1;
    }
}

int main(int argc, char **argv) {
    if (argc != 3 && argc != 4) {
        fprintf(stderr, "usage: watch-processes <out.jsonl> <stop file> [all]\n");
        return 2;
    }
    FILE *out = fopen(argv[1], "w");
    if (!out) return 1;
    static pid_t pids[16384];
    static char path[PROC_PIDPATHINFO_MAXSIZE], line[1 << 16];
    long samples = 0;
    while (access(argv[2], F_OK) != 0) {
        int n = proc_listallpids(pids, sizeof(pids));
        samples++;
        for (int i = 0; i < n; i++) {
            if (pids[i] <= 0 || proc_pidpath(pids[i], path, sizeof(path)) <= 0) continue;
            if (remember(key(pids[i], path))) continue;
            args(pids[i], line, sizeof(line));
            if (argc == 3 && !watched(path) && !watched(line)) continue;
            struct proc_bsdinfo info;
            int ppid = proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &info, sizeof(info)) == sizeof(info) ? (int)info.pbi_ppid : -1;
            struct timespec ts;
            clock_gettime(CLOCK_REALTIME, &ts);
            fprintf(out, "{\"t\":%ld.%03ld,\"pid\":%d,\"ppid\":%d,\"executable\":", (long)ts.tv_sec, ts.tv_nsec / 1000000, pids[i], ppid);
            json(out, path);
            fprintf(out, ",\"commandLine\":");
            json(out, line);
            fprintf(out, "}\n");
            fflush(out);
        }
        usleep(2000);
    }
    fprintf(stderr, "%ld samples, %d (pid, executable) pairs\n", samples, nseen);
    fclose(out);
    return 0;
}
