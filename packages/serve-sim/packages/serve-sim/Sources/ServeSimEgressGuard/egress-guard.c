// Local native prototype; not wired into serve-sim startup or warm adoption.
// @ref LLP 0007.001#covered-operations-and-transition-result — publication does not drain calls that already sampled pass-through
#include "policy.h"
#include "destination.h"
#include <errno.h>
#include <stdlib.h>
#include <sys/uio.h>
#include <unistd.h>

static _Atomic(struct EgressPage *) policy_page;

__attribute__((constructor)) static void eg_initialize(void) {
  int saved = errno, fd = -1;
  // Boot-env test adapter; capability-loader discovery is gated on the benchmarks.
  struct EgressPage *page = eg_map_policy(getenv("SERVE_SIM_EGRESS_POLICY_FILE"), 0, &fd);
  if (fd >= 0) close(fd);
  atomic_store_explicit(&policy_page, page, memory_order_release);
  errno = saved;
}

static int eg_passthrough(void) {
  struct EgressPage *page = atomic_load_explicit(&policy_page, memory_order_acquire);
  if (!page || atomic_load_explicit(&page->magic, memory_order_acquire) != EG_MAGIC) return 0;
  uint64_t value = atomic_load_explicit(&page->policy, memory_order_acquire);
  return (value >> 2) != 0 && (value & 3) == EG_PASSTHROUGH;
}

static int eg_peer_remote(int fd) {
  int saved = errno;
  struct sockaddr_storage address;
  socklen_t size = sizeof address;
  int result = getpeername(fd, (struct sockaddr *)&address, &size);
  int remote = result == 0 && eg_remote((const struct sockaddr *)&address, size);
  if (result < 0 && errno != ENOTSOCK && errno != EBADF) {
    // An internet socket with an unresolved/pending peer must not pass through.
    // Otherwise a pending connect could complete between inspection and send.
    size = sizeof address;
    remote = getsockname(fd, (struct sockaddr *)&address, &size) != 0 ||
             address.ss_family == AF_INET || address.ss_family == AF_INET6;
  }
  // Files/Unix sockets pass through. Concurrent fd replacement is outside this prototype's guarantee.
  errno = saved;
  return remote;
}

static int eg_disconnect(int fd, const struct sockaddr *sa, socklen_t size) {
  if (!sa || size < 2 || sa->sa_family != AF_UNSPEC) return 0;
  int saved = errno, type = 0;
  socklen_t length = sizeof type;
  int disconnect = getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &length) == 0 && type == SOCK_DGRAM;
  errno = saved;
  return disconnect;
}

#define EG_REFUSE() do { errno = ECONNREFUSED; return -1; } while (0)

extern int eg_connect_nc_original(int, const struct sockaddr *, socklen_t) __asm__("_connect$NOCANCEL");
extern ssize_t eg_sendto_nc_original(int, const void *, size_t, int, const struct sockaddr *, socklen_t) __asm__("_sendto$NOCANCEL");
extern ssize_t eg_sendmsg_nc_original(int, const struct msghdr *, int) __asm__("_sendmsg$NOCANCEL");
extern ssize_t eg_write_nc_original(int, const void *, size_t) __asm__("_write$NOCANCEL");
extern ssize_t eg_writev_nc_original(int, const struct iovec *, int) __asm__("_writev$NOCANCEL");

#define CONNECT_WRAPPER(name, original) \
static int name(int fd, const struct sockaddr *sa, socklen_t size) { \
  if (!eg_passthrough() && !eg_disconnect(fd, sa, size) && eg_remote(sa, size)) EG_REFUSE(); \
  return original(fd, sa, size); \
}
CONNECT_WRAPPER(eg_connect, connect)
CONNECT_WRAPPER(eg_connect_nc, eg_connect_nc_original)

static int eg_connectx(int fd, const sa_endpoints_t *endpoints, sae_associd_t assoc, unsigned flags,
                       const struct iovec *iov, unsigned count, size_t *length, sae_connid_t *id) {
  if (!eg_passthrough() && endpoints && !eg_disconnect(fd, endpoints->sae_dstaddr, endpoints->sae_dstaddrlen) &&
      eg_remote(endpoints->sae_dstaddr, endpoints->sae_dstaddrlen)) EG_REFUSE();
  return connectx(fd, endpoints, assoc, flags, iov, count, length, id);
}

#define SENDTO_WRAPPER(name, original) \
static ssize_t name(int fd, const void *buf, size_t size, int flags, const struct sockaddr *sa, socklen_t length) { \
  if (!eg_passthrough() && (sa ? eg_remote(sa, length) : eg_peer_remote(fd))) EG_REFUSE(); \
  return original(fd, buf, size, flags, sa, length); \
}
SENDTO_WRAPPER(eg_sendto, sendto)
SENDTO_WRAPPER(eg_sendto_nc, eg_sendto_nc_original)

#define SENDMSG_WRAPPER(name, original) \
static ssize_t name(int fd, const struct msghdr *msg, int flags) { \
  if (!eg_passthrough() && (msg && msg->msg_name && msg->msg_namelen ? \
      eg_remote(msg->msg_name, msg->msg_namelen) : eg_peer_remote(fd))) EG_REFUSE(); \
  return original(fd, msg, flags); \
}
SENDMSG_WRAPPER(eg_sendmsg, sendmsg)
SENDMSG_WRAPPER(eg_sendmsg_nc, eg_sendmsg_nc_original)

static ssize_t eg_send(int fd, const void *buf, size_t size, int flags) {
  if (!eg_passthrough() && eg_peer_remote(fd)) EG_REFUSE();
  return send(fd, buf, size, flags);
}

#define WRITE_WRAPPER(name, original) \
static ssize_t name(int fd, const void *buf, size_t size) { \
  if (!eg_passthrough() && eg_peer_remote(fd)) EG_REFUSE(); \
  return original(fd, buf, size); \
}
WRITE_WRAPPER(eg_write, write)
WRITE_WRAPPER(eg_write_nc, eg_write_nc_original)

#define WRITEV_WRAPPER(name, original) \
static ssize_t name(int fd, const struct iovec *iov, int count) { \
  if (!eg_passthrough() && eg_peer_remote(fd)) EG_REFUSE(); \
  return original(fd, iov, count); \
}
WRITEV_WRAPPER(eg_writev, writev)
WRITEV_WRAPPER(eg_writev_nc, eg_writev_nc_original)

#define EG_INTERPOSE(replacement, original) {(const void *)replacement, (const void *)original}
__attribute__((used)) static const struct { const void *replacement; const void *original; }
eg_interposers[] __attribute__((section("__DATA,__interpose"))) = {
  EG_INTERPOSE(eg_connect, connect), EG_INTERPOSE(eg_connect_nc, eg_connect_nc_original),
  EG_INTERPOSE(eg_connectx, connectx), EG_INTERPOSE(eg_send, send),
  EG_INTERPOSE(eg_sendto, sendto), EG_INTERPOSE(eg_sendto_nc, eg_sendto_nc_original),
  EG_INTERPOSE(eg_sendmsg, sendmsg), EG_INTERPOSE(eg_sendmsg_nc, eg_sendmsg_nc_original),
  EG_INTERPOSE(eg_write, write), EG_INTERPOSE(eg_write_nc, eg_write_nc_original),
  EG_INTERPOSE(eg_writev, writev), EG_INTERPOSE(eg_writev_nc, eg_writev_nc_original),
};
