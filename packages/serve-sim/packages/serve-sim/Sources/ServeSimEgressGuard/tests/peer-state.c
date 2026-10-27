// Test-only interposer: model ENOTCONN at inspection, then a connected peer at send.
#include <errno.h>
#include <sys/socket.h>

static int unresolved_peer(int fd, struct sockaddr *address, socklen_t *length) {
  int saved = errno, type = 0;
  socklen_t type_size = sizeof type;
  struct sockaddr_storage own;
  socklen_t own_size = sizeof own;
  if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &type_size) == 0 && type == SOCK_STREAM &&
      getsockname(fd, (struct sockaddr *)&own, &own_size) == 0 &&
      (own.ss_family == AF_INET || own.ss_family == AF_INET6)) {
    errno = ENOTCONN;
    return -1;
  }
  errno = saved;
  return getpeername(fd, address, length);
}

__attribute__((used)) static const struct { const void *replacement; const void *original; }
interposers[] __attribute__((section("__DATA,__interpose"))) = {
  {(const void *)unresolved_peer, (const void *)getpeername},
};
