#include "fixture.h"
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/uio.h>
#include <unistd.h>

static int failures;
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "FAIL line %d: %s (errno %d)\n", __LINE__, #x, errno); failures++; } } while (0)
#define REQUIRE(x) do { if (!(x)) { perror(#x); return 2; } } while (0)

static int bound(int type, struct sockaddr_in *address) {
  int fd = socket(AF_INET, type, 0);
  if (fd < 0) return -1;
  memset(address, 0, sizeof *address);
  address->sin_len = sizeof *address;
  address->sin_family = AF_INET;
  address->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  socklen_t size = sizeof *address;
  struct timeval timeout = {1, 0};
  if (bind(fd, (struct sockaddr *)address, size) || getsockname(fd, (struct sockaddr *)address, &size) ||
      setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout)) { close(fd); return -1; }
  return fd;
}

static ssize_t transmit(int fd, int which) {
  char byte = 'x';
  struct iovec vec = {&byte, 1};
  struct msghdr msg = {0}; msg.msg_iov = &vec; msg.msg_iovlen = 1;
  switch (which) {
    case 0: return send(fd, &byte, 1, 0);
    case 1: return write(fd, &byte, 1);
    case 2: return writev(fd, &vec, 1);
    case 3: return sendto(fd, &byte, 1, 0, NULL, 0);
    default: return sendmsg(fd, &msg, 0);
  }
}

static void expect_sends(int sender, int receiver, int denied) {
  for (int which = 0; which < 5; which++) {
    errno = 0;
    ssize_t n = transmit(sender, which);
    if (denied) CHECK(n == -1 && errno == ECONNREFUSED); else CHECK(n == 1);
    if (n == 1) { char byte; CHECK(recv(receiver, &byte, 1, 0) == 1 && byte == 'x'); }
  }
}

static void expect_nocancel(int sender, int receiver) {
  ssize_t (*write_nc)(int, const void *, size_t) = dlsym(RTLD_DEFAULT, "write$NOCANCEL");
  ssize_t (*writev_nc)(int, const struct iovec *, int) = dlsym(RTLD_DEFAULT, "writev$NOCANCEL");
  ssize_t (*sendto_nc)(int, const void *, size_t, int, const struct sockaddr *, socklen_t) = dlsym(RTLD_DEFAULT, "sendto$NOCANCEL");
  ssize_t (*sendmsg_nc)(int, const struct msghdr *, int) = dlsym(RTLD_DEFAULT, "sendmsg$NOCANCEL");
  CHECK(write_nc && writev_nc && sendto_nc && sendmsg_nc);
  if (!write_nc || !writev_nc || !sendto_nc || !sendmsg_nc) return;
  struct iovec vec = {(void *)"x", 1};
  struct msghdr msg = {0}; msg.msg_iov = &vec; msg.msg_iovlen = 1;
  ssize_t results[] = {write_nc(sender, "x", 1), writev_nc(sender, &vec, 1),
                      sendto_nc(sender, "x", 1, 0, NULL, 0), sendmsg_nc(sender, &msg, 0)};
  for (size_t i = 0; i < sizeof results / sizeof results[0]; i++) {
    CHECK(results[i] == -1);
    if (results[i] == 1) { char byte; CHECK(recv(receiver, &byte, 1, 0) == 1); }
  }
}

int main(int argc, char **argv) {
  REQUIRE(argc == 3);
  struct sockaddr_in tcp_address, udp_address;
  int listener = bound(SOCK_STREAM, &tcp_address), receiver = bound(SOCK_DGRAM, &udp_address);
  REQUIRE(listener >= 0 && receiver >= 0 && listen(listener, 4) == 0);
  int tcp = socket(AF_INET, SOCK_STREAM, 0), udp = socket(AF_INET, SOCK_DGRAM, 0);
  REQUIRE(tcp >= 0 && udp >= 0);
  if (strcmp(argv[2], "invalid") == 0) {
    CHECK(connect(tcp, (struct sockaddr *)&tcp_address, sizeof tcp_address) == -1 && errno == ECONNREFUSED);
  } else {
    int page_fd = open(argv[1], O_RDWR); REQUIRE(page_fd >= 0);
    struct TestPage *page = mmap(NULL, TEST_PAGE_BYTES, PROT_READ | PROT_WRITE, MAP_SHARED, page_fd, 0);
    REQUIRE(page != MAP_FAILED); close(page_fd);
    REQUIRE(connect(tcp, (struct sockaddr *)&tcp_address, sizeof tcp_address) == 0);
    REQUIRE(connect(udp, (struct sockaddr *)&udp_address, sizeof udp_address) == 0);
    int accepted = accept(listener, NULL, NULL); REQUIRE(accepted >= 0);
    int duplicate = dup(udp); REQUIRE(duplicate >= 0);
    expect_sends(tcp, accepted, 0); expect_sends(udp, receiver, 0);
    atomic_store_explicit(&page->policy, (UINT64_C(2) << 2) | 2, memory_order_release);
    expect_sends(tcp, accepted, 1); expect_sends(udp, receiver, 1); expect_sends(duplicate, receiver, 1);
    expect_nocancel(tcp, accepted); expect_nocancel(udp, receiver);
    CHECK(sendto(udp, "x", 1, 0, (struct sockaddr *)&udp_address, sizeof udp_address) == -1 && errno == ECONNREFUSED);
    int fresh = socket(AF_INET, SOCK_DGRAM, 0); REQUIRE(fresh >= 0);
    // A pending/unconnected internet socket cannot become a peer-lookup bypass.
    CHECK(write(fresh, "x", 1) == -1 && errno == ECONNREFUSED);
    CHECK(connect(fresh, (struct sockaddr *)&udp_address, sizeof udp_address) == -1 && errno == ECONNREFUSED);
    int (*connect_nc)(int, const struct sockaddr *, socklen_t) = dlsym(RTLD_DEFAULT, "connect$NOCANCEL");
    REQUIRE(connect_nc);
    CHECK(connect_nc(fresh, (struct sockaddr *)&udp_address, sizeof udp_address) == -1 && errno == ECONNREFUSED);
    sa_endpoints_t endpoints = {0}; endpoints.sae_dstaddr = (struct sockaddr *)&udp_address;
    endpoints.sae_dstaddrlen = sizeof udp_address;
    CHECK(connectx(fresh, &endpoints, SAE_ASSOCID_ANY, 0, NULL, 0, NULL, NULL) == -1 && errno == ECONNREFUSED);
    close(fresh);
    atomic_store_explicit(&page->policy, (UINT64_C(3) << 2) | 1, memory_order_release);
    expect_sends(tcp, accepted, 0); expect_sends(udp, receiver, 0);
    atomic_store_explicit(&page->policy, (UINT64_C(4) << 2) | 2, memory_order_release);
    expect_sends(tcp, accepted, 1); expect_sends(udp, receiver, 1);
    atomic_store_explicit(&page->policy, (UINT64_C(5) << 2) | 3, memory_order_release);
    expect_sends(udp, receiver, 1); // unknown mode must fail closed
    close(duplicate); close(accepted); munmap(page, TEST_PAGE_BYTES);
  }
  int unix_pair[2]; REQUIRE(socketpair(AF_UNIX, SOCK_STREAM, 0, unix_pair) == 0);
  expect_sends(unix_pair[0], unix_pair[1], 0);
  // Reuse the old socket's fd for a file while blocked. No stale socket classification.
  close(udp); int file = open("/dev/null", O_WRONLY); REQUIRE(file >= 0);
  REQUIRE(dup2(file, udp) == udp);
  errno = EDOM; CHECK(write(udp, "x", 1) == 1 && errno == EDOM);
  struct iovec vec = {(void *)"x", 1}; CHECK(writev(udp, &vec, 1) == 1);
  if (file != udp) close(file);
  close(udp); close(tcp); close(listener); close(receiver); close(unix_pair[0]); close(unix_pair[1]);
  printf("%d failures\n", failures);
  return failures ? 1 : 0;
}
