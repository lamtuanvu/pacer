/* Fixed Darwin ABI wrapper: variadic fcntl cannot be called as fixed-arity FFI. */
extern int fcntl(int, int, ...);
int pacer_native_transport_abi(void) { return 1; }
int pacer_descriptor_flags(int fd) {
    int flags = fcntl(fd, 3); /* F_GETFL */
    if (flags < 0 || fcntl(fd, 2, 1) < 0) return -1; /* F_SETFD, FD_CLOEXEC */
    return fcntl(fd, 4, flags | 4); /* F_SETFL, O_NONBLOCK */
}
