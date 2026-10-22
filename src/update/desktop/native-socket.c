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
int pacer_receive_listener(int channel) {
    union { unsigned long alignment; unsigned char bytes[44]; } control = {0};
    unsigned char marker = 0;
    struct pacer_iovec iov = { &marker, 1 };
    struct pacer_msghdr message = {0, 0, &iov, 1, control.bytes, sizeof(control.bytes), 0};
    long deadline[2] = {10, 0};
    int descriptors[8], count = 0, invalid = 0;
    unsigned int offset = 0;
    if (setsockopt(channel, 0xffff, 0x1006, deadline, sizeof(deadline)) < 0) return -1;
    long received = recvmsg(channel, &message, 0);
    deadline[0] = 0;
    if (setsockopt(channel, 0xffff, 0x1006, deadline, sizeof(deadline)) < 0) invalid = 1;
    if (received != 1 || marker != 'P' || (message.flags & 0x30)) invalid = 1;
    while (offset + sizeof(struct pacer_cmsghdr) <= message.control_length) {
        struct pacer_cmsghdr *header = (struct pacer_cmsghdr *)(control.bytes + offset);
        if (header->length < 12 || header->length > message.control_length - offset) { invalid = 1; break; }
        if (header->level != 0xffff || header->type != 1 || (header->length - 12) % 4) invalid = 1;
        else {
            unsigned int index;
            for (index = 12; index + 4 <= header->length; index += 4) {
                int fd = *(int *)(control.bytes + offset + index);
                if (count < 8) descriptors[count++] = fd;
                else { close(fd); invalid = 1; }
            }
        }
        offset += (header->length + 3) & ~3u;
    }
    if (offset != message.control_length || count != 1) invalid = 1;
    if (!invalid) {
        int type = 0;
        unsigned int size = sizeof(int);
        if (getsockopt(descriptors[0], 0xffff, 0x1008, &type, &size) < 0 || type != 1) invalid = 1;
        if (!invalid && pacer_descriptor_flags(descriptors[0]) < 0) invalid = 1;
    }
    if (invalid) { while (count) close(descriptors[--count]); return -1; }
    return descriptors[0];
}
