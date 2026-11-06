# ompweb.local.ps1 -- machine-specific settings for the Windows stack.
# Copy to ompweb.local.ps1 (git-ignored) and adjust. Dot-sourced by ompweb.ps1
# before it reads any default, so it is the single place where this machine's
# stack is described: port, bind, password hash, allowed hosts, CA certificate.

# Where the supervised instance listens.
$OmpWebPort = 6767
$OmpWebBind = '0.0.0.0'

# Optional: absolute path to node.exe. Defaults to node.exe from PATH.
# $OmpWebNode = 'C:\Program Files\nodejs\node.exe'

# Password gate. Generate with:
#   node bin\omp-web.js hash-password        (reads stdin, prints the scrypt hash)
# Never put OMP_WEB_PASSWORD (plaintext) here: every omp session inherits the
# environment and can print it into its transcript.
$env:OMP_WEB_PASSWORD_HASH = 'scrypt$...$...$...$...'

# Hosts allowed in the Host header when binding beyond loopback.
$env:OMP_WEB_ALLOWED_HOSTS = '192.168.1.88'

# Trust a private CA (Bun reads this; the host daemon and every omp session inherit it).
$env:NODE_EXTRA_CA_CERTS = 'C:\Work\ompweb\ca.cer'

# Git for Windows bash ahead of the WSL launcher in C:\Windows\System32, so an
# explicitly invoked `bash` is Git bash. Git\bin only: prepending Git\usr\bin
# would shadow the System32 find/tar/whoami for every child process.
if (Test-Path 'C:\Program Files\Git\bin\bash.exe') { $env:Path = 'C:\Program Files\Git\bin;' + $env:Path }
