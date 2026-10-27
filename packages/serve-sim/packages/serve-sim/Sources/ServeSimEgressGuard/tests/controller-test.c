// A long-lived guarded process. Only the external control helper changes policy.
#include <arpa/inet.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int bound(int type, struct sockaddr_in *address) {
  int fd = socket(AF_INET, type, 0);
  memset(address, 0, sizeof *address);
  address->sin_len = sizeof *address; address->sin_family = AF_INET;
  address->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  socklen_t size = sizeof *address;
  if (fd < 0 || bind(fd, (struct sockaddr *)address, size) || getsockname(fd, (struct sockaddr *)address, &size)) return -1;
  return fd;
}

int main(void) {
  struct sockaddr_in tcp_address, udp_address;
  int listener = bound(SOCK_STREAM, &tcp_address), receiver = bound(SOCK_DGRAM, &udp_address);
  if (listener < 0 || receiver < 0 || listen(listener, 4)) return 2;
  int tcp = socket(AF_INET, SOCK_STREAM, 0), udp = socket(AF_INET, SOCK_DGRAM, 0);
  if (tcp < 0 || udp < 0 || connect(tcp, (struct sockaddr *)&tcp_address, sizeof tcp_address) ||
      connect(udp, (struct sockaddr *)&udp_address, sizeof udp_address)) return 2;
  int accepted = accept(listener, NULL, NULL);
  if (accepted < 0) return 2;
  puts("ready"); fflush(stdout);
  char command[32];
  while (fgets(command, sizeof command, stdin)) {
    int block = strcmp(command, "block\n") == 0;
    if (!block && strcmp(command, "passthrough\n") != 0) return 3;
    int senders[] = {tcp, udp}, receivers[] = {accepted, receiver};
    for (int i = 0; i < 2; i++) {
      errno = 0;
      ssize_t sent = send(senders[i], "x", 1, 0);
      if (block) { if (sent != -1 || errno != ECONNREFUSED) return 4; }
      else {
        char byte;
        if (sent != 1 || recv(receivers[i], &byte, 1, 0) != 1 || byte != 'x') return 5;
      }
    }
    printf("ok %s", command); fflush(stdout);
  }
  close(tcp); close(udp); close(accepted); close(listener); close(receiver);
  return 0;
}
