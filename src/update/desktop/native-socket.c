/* Fixed Darwin ABI wrapper: variadic fcntl cannot be called as fixed-arity FFI. */
extern int fcntl(int, int, ...);
int pacer_native_transport_abi(void) { return 1; }
int pacer_descriptor_flags(int fd) {
    int flags = fcntl(fd, 3); /* F_GETFL */
    if (flags < 0 || fcntl(fd, 2, 1) < 0) return -1; /* F_SETFD, FD_CLOEXEC */
    return fcntl(fd, 4, flags | 4); /* F_SETFL, O_NONBLOCK */
}

/* Public 64-bit Darwin socket ABI, also usable by the development TinyCC shim
 * without requiring an Xcode SDK. Ancillary headers are aligned to 4 bytes. */
struct pacer_iovec { void *base; unsigned long length; };
struct pacer_msghdr {
    void *name;
    unsigned int name_length;
    struct pacer_iovec *iov;
    int iov_count;
    void *control;
    unsigned int control_length;
    int flags;
};
struct pacer_cmsghdr { unsigned int length; int level; int type; };
extern long recvmsg(int, struct pacer_msghdr *, int);
extern int setsockopt(int, int, int, const void *, unsigned int);
extern int getsockopt(int, int, int, void *, unsigned int *);
extern int close(int);

/* Only the authenticated parent bootstrap channel may supply this descriptor.
 * Close every delivered right on any error, including truncated/extra rights. */

/* Additive helper broker ABI. Darwin constants/layout are SDK-checked by tests. */
struct pacer_pollfd { int fd; short events; short revents; };
struct pacer_timespec { long seconds; long nanos; };
struct pacer_stat64 {
    int device; unsigned short mode; unsigned short links;
    unsigned long inode; unsigned int uid; unsigned int gid; int rdevice;
    long access_time[2], modify_time[2], change_time[2], birth_time[2];
    long size, blocks; int block_size; unsigned int flags, generation; int spare;
    long reserved[2];
};
#if defined(__arm64__) || defined(__aarch64__)
extern int pacer_fstat(int, struct pacer_stat64 *) __asm("_fstat");
#else
extern int pacer_fstat(int, struct pacer_stat64 *) __asm("_fstat$INODE64");
#endif
extern int poll(struct pacer_pollfd *, unsigned int, int);
extern int clock_gettime(int, struct pacer_timespec *);
extern long send(int, const void *, unsigned long, int);
extern int shutdown(int, int);
extern int *__error(void);
/* Fixed failure-only metadata. Never authority or a request selector. */
static int pacer_failure(int *diagnostic, int stage, int category) {
    if (diagnostic) { diagnostic[0] = stage; diagnostic[1] = category; }
    return -1;
}
static int pacer_error_category(int error) {
    switch (error) {
        case 32: return 14; /* EPIPE */
        case 35: return 15; /* EAGAIN */
        case 9: return 16; /* EBADF */
        case 22: return 17; /* EINVAL */
        case 1: return 18; /* EPERM */
        case 13: return 19; /* EACCES */
        case 40: return 20; /* EMSGSIZE */
        case 54: return 21; /* ECONNRESET */
        case 55: return 22; /* ENOBUFS */
        case 38: return 23; /* ENOTSOCK */
        case 4: return 24; /* EINTR */
        case 12: return 26; /* ENOMEM */
        case 5: return 27; /* EIO */
        case 36: return 28; /* EINPROGRESS */
        case 37: return 29; /* EALREADY */
        default: return 25;
    }
}
static long pacer_millis(void) {
    struct pacer_timespec t;
    if (clock_gettime(6, &t) < 0) return -1; /* CLOCK_MONOTONIC */
    return t.seconds * 1000 + t.nanos / 1000000;
}
static int pacer_wait(int fd, short events, long deadline, int *diagnostic, int stage) {
    struct pacer_pollfd p = {fd, events, 0};
    for (;;) {
        long now = pacer_millis();
        int result, error;
        if (now < 0) return pacer_failure(diagnostic, stage, 2);
        if (now >= deadline) return pacer_failure(diagnostic, stage, 3);
        result = poll(&p, 1, (int)(deadline - now));
        error = result < 0 ? *__error() : 0;
        if (result > 0) {
            if (p.revents & events) return 0;
            return pacer_failure(diagnostic, stage, (p.revents & 0x20) ? 6 :
                (p.revents & 0x10) ? 5 : (p.revents & 8) ? 7 : 8);
        }
        if (result == 0) return pacer_failure(diagnostic, stage, 4);
        if (error != 4) return pacer_failure(diagnostic, stage, pacer_error_category(error));
    }
}
static int pacer_cloexec(int fd) {
    int flags = fcntl(fd, 1); /* F_GETFD */
    return flags < 0 ? -1 : fcntl(fd, 2, flags | 1);
}
static int pacer_unix_stream(int fd) {
    int type = 0;
    unsigned int size = sizeof(type);
    unsigned char address[256] = {0};
    extern int getsockname(int, void *, unsigned int *);
    if (getsockopt(fd, 0xffff, 0x1008, &type, &size) < 0 || size != sizeof(type) || type != 1) return -1;
    size = sizeof(address);
    return getsockname(fd, address, &size) == 0 && size >= 2 && address[1] == 1 ? 0 : -1;
}
/* All messages use bounded recvmsg, including continuation bytes, so rights
 * cannot be silently discarded by ordinary read() during fragmented replies. */
static int pacer_receive_rights(int channel, unsigned char *bytes, unsigned int length,
    int *fds, int *count, int maximum, long deadline, int *diagnostic) {
    unsigned int used = 0;
    int invalid = 0, category = 1;
    while (used < length) {
        /* Darwin rejects SCM_RIGHTS messages with >254 descriptors. Space for
         * 1021 rights avoids its unsafe undersized-buffer truncation behavior;
         * still reject CTRUNC and close all complete delivered slots. */
        union { unsigned long alignment; unsigned char bytes[4096]; } control = {0};
        struct pacer_iovec iov = {bytes + used, length - used};
        struct pacer_msghdr m = {0, 0, &iov, 1, control.bytes, sizeof(control.bytes), 0};
        unsigned int offset = 0;
        long received;
        if (pacer_wait(channel, 1, deadline, diagnostic, 8) < 0) return -1;
        received = recvmsg(channel, &m, 0x80); /* MSG_DONTWAIT */
        if (received < 0) {
            int error = *__error();
            if (error == 4 || error == 35) continue;
            return pacer_failure(diagnostic, 9, pacer_error_category(error));
        }
        if (received == 0) return pacer_failure(diagnostic, 9, 9);
        if (m.flags & 0x30) { invalid = 1; category = 10; } /* MSG_CTRUNC | MSG_TRUNC */
        while (offset + sizeof(struct pacer_cmsghdr) <= m.control_length) {
            struct pacer_cmsghdr *h = (struct pacer_cmsghdr *)(control.bytes + offset);
            unsigned int available = m.control_length - offset;
            unsigned int complete = h->length < available ? h->length : available;
            if (h->length < 12) { invalid = 1; break; }
            if (h->length > available) invalid = 1;
            if (h->level != 0xffff || h->type != 1 || (h->length - 12) % 4) invalid = 1;
            else {
                unsigned int i;
                for (i = 12; i + 4 <= complete; i += 4) {
                    int fd = *(int *)(control.bytes + offset + i);
                    if (pacer_cloexec(fd) < 0) { close(fd); invalid = 1; category = 12; }
                    else if (*count < maximum) fds[(*count)++] = fd;
                    else { close(fd); invalid = 1; category = 11; }
                }
            }
            if (h->length > available) break;
            offset += (h->length + 3) & ~3u;
        }
        if (offset != m.control_length) invalid = 1;
        if (invalid) return pacer_failure(diagnostic, 10, category);
        used += (unsigned int)received;
    }
    return 0;
}
/* The caller authenticates fd0's peer before calling. Keep this control stream
 * blocking: request I/O uses MSG_DONTWAIT plus a single monotonic deadline. */
static int pacer_receive_single(int channel, unsigned char expected, int nonblocking) {
    unsigned char marker = 0;
    int fds[1], count = 0;
    long now = pacer_millis();
    if (now < 0 || pacer_receive_rights(channel, &marker, 1, fds, &count, 1, now + 10000, (int *)0) < 0
        || marker != expected || count != 1 || pacer_unix_stream(fds[0]) < 0
        || pacer_cloexec(fds[0]) < 0) {
        while (count) close(fds[--count]);
        return -1;
    }
    {
        int flags = fcntl(fds[0], 3);
        int yes = 1;
        if (flags < 0 || fcntl(fds[0], 4, nonblocking ? flags | 4 : flags & ~4) < 0
            || setsockopt(fds[0], 0xffff, 0x1022, &yes, sizeof(yes)) < 0) { close(fds[0]); return -1; }
    }
    return fds[0];
}
int pacer_receive_listener(int channel) { return pacer_receive_single(channel, 'P', 1); }
int pacer_receive_helper_channel(int channel) { return pacer_receive_single(channel, 'C', 0); }
static int pacer_pipe(int fd, int access) {
    struct pacer_stat64 st;
    int flags = fcntl(fd, 3);
    return flags >= 0 && (flags & 3) == access && pacer_fstat(fd, &st) == 0
        && (st.mode & 0170000) == 0010000 ? 0 : -1;
}
/* Returns the PID and transfers exactly three owned FDs through out[0..2].
 * On failure all received rights close, out stays -1, and the borrowed channel
 * is shut down (its owner closes it exactly once). No PID signals occur here. */
int pacer_request_helper(int channel, const unsigned char *json, unsigned int length, int *out) {
    unsigned char header[4], reply[5] = {0};
    int fds[3], count = 0, i, yes = 1, report = 0;
    int diagnostic[2] = {1, 1};
    unsigned int part, pid;
    long now = pacer_millis(), deadline = now + 10000;
    if (!out) return -1;
    for (i = 0; i < 4; i++) out[i] = -1;
    if (now < 0) { pacer_failure(diagnostic, 1, 2); goto fail; }
    if (!json || !length || length > 8192) goto fail;
    if (pacer_unix_stream(channel) < 0) { pacer_failure(diagnostic, 2, 1); goto fail; }
    if (setsockopt(channel, 0xffff, 0x1022, &yes, sizeof(yes)) < 0) {
        pacer_failure(diagnostic, 3, pacer_error_category(*__error())); goto fail;
    }
    report = 1; /* SO_NOSIGPIPE succeeded for this borrowed channel. */
    header[0] = (unsigned char)(length >> 24); header[1] = (unsigned char)(length >> 16);
    header[2] = (unsigned char)(length >> 8); header[3] = (unsigned char)length;
    for (part = 0; part < 2; part++) {
        const unsigned char *bytes = part ? json : header;
        unsigned int remaining = part ? length : 4;
        while (remaining) {
            long sent;
            if (pacer_wait(channel, 4, deadline, diagnostic, part ? 6 : 4) < 0) goto fail;
            sent = send(channel, bytes, remaining, 0x80);
            if (sent < 0) {
                int error = *__error();
                if (error == 4 || error == 35) continue;
                pacer_failure(diagnostic, part ? 7 : 5, pacer_error_category(error)); goto fail;
            }
            if (sent == 0) { pacer_failure(diagnostic, part ? 7 : 5, 13); goto fail; }
            bytes += sent; remaining -= (unsigned int)sent;
        }
    }
    if (pacer_receive_rights(channel, reply, 5, fds, &count, 3, deadline, diagnostic) < 0) goto fail;
    pid = ((unsigned int)reply[1] << 24) | ((unsigned int)reply[2] << 16)
        | ((unsigned int)reply[3] << 8) | reply[4];
    if (reply[0] != 'H' || pid <= 1 || pid > 2147483647u || count != 3) {
        pacer_failure(diagnostic, 11, 1); goto fail;
    }
    if (pacer_pipe(fds[0], 1) < 0) { pacer_failure(diagnostic, 12, 1); goto fail; }
    if (pacer_pipe(fds[1], 0) < 0) { pacer_failure(diagnostic, 13, 1); goto fail; }
    if (pacer_unix_stream(fds[2]) < 0) { pacer_failure(diagnostic, 14, 1); goto fail; }
    for (i = 0; i < 3; i++) if (pacer_cloexec(fds[i]) < 0) {
        pacer_failure(diagnostic, 15, pacer_error_category(*__error())); goto fail;
    }
    /* Preserve original blocking pipe/nonblocking control semantics. */
    for (i = 0; i < 2; i++) {
        int flags = fcntl(fds[i], 3);
        if (flags < 0 || fcntl(fds[i], 4, flags & ~4) < 0) {
            pacer_failure(diagnostic, 15, pacer_error_category(*__error())); goto fail;
        }
    }
    if (pacer_descriptor_flags(fds[2]) < 0 || setsockopt(fds[2], 0xffff, 0x1022, &yes, sizeof(yes)) < 0) {
        pacer_failure(diagnostic, 16, pacer_error_category(*__error())); goto fail;
    }
    for (i = 0; i < 3; i++) out[i] = fds[i];
    return (int)pid;
fail:
    while (count) close(fds[--count]);
    if (report) {
        unsigned char failure[3] = {'D', (unsigned char)diagnostic[0], (unsigned char)diagnostic[1]};
        /* One best-effort nonblocking observation; never retry or grant authority. */
        (void)send(channel, failure, sizeof(failure), 0x80);
    }
    shutdown(channel, 2);
    return -1;
}
