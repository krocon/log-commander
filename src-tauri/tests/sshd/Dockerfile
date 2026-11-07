# OpenSSH for `tests/sftp_integration.rs` (prompt 017, ignored tests). Throwaway keys only, see start.sh.
FROM alpine:3.20
RUN apk add --no-cache openssh-server openssh-sftp-server && \
    adduser -D -s /bin/sh test && echo 'test:test-password' | chpasswd && \
    mkdir -p /home/test/.ssh /var/log/app && chown -R test /home/test/.ssh /var/log/app && chmod 700 /home/test/.ssh
COPY authorized_keys /home/test/.ssh/authorized_keys
COPY ssh_host_ed25519_key /etc/ssh/ssh_host_ed25519_key
RUN chown test /home/test/.ssh/authorized_keys && chmod 600 /home/test/.ssh/authorized_keys /etc/ssh/ssh_host_ed25519_key && \
    printf 'Port 22\nHostKey /etc/ssh/ssh_host_ed25519_key\nPasswordAuthentication yes\nPubkeyAuthentication yes\nKbdInteractiveAuthentication no\nSubsystem sftp internal-sftp\nAllowTcpForwarding no\nX11Forwarding no\n' > /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
