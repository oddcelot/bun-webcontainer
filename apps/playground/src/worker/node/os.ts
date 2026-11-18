// os.constants as Node has them on Linux x64, the platform the playground reports.
const ERRNO =
  "E2BIG:7 EACCES:13 EADDRINUSE:98 EADDRNOTAVAIL:99 EAFNOSUPPORT:97 EAGAIN:11 EALREADY:114 EBADF:9 EBADMSG:74 EBUSY:16 ECANCELED:125 ECHILD:10 ECONNABORTED:103 ECONNREFUSED:111 ECONNRESET:104 EDEADLK:35 EDESTADDRREQ:89 EDOM:33 EDQUOT:122 EEXIST:17 EFAULT:14 EFBIG:27 EHOSTUNREACH:113 EIDRM:43 EILSEQ:84 EINPROGRESS:115 EINTR:4 EINVAL:22 EIO:5 EISCONN:106 EISDIR:21 ELOOP:40 EMFILE:24 EMLINK:31 EMSGSIZE:90 EMULTIHOP:72 ENAMETOOLONG:36 ENETDOWN:100 ENETRESET:102 ENETUNREACH:101 ENFILE:23 ENOBUFS:105 ENODATA:61 ENODEV:19 ENOENT:2 ENOEXEC:8 ENOLCK:37 ENOLINK:67 ENOMEM:12 ENOMSG:42 ENOPROTOOPT:92 ENOSPC:28 ENOSR:63 ENOSTR:60 ENOSYS:38 ENOTCONN:107 ENOTDIR:20 ENOTEMPTY:39 ENOTSOCK:88 ENOTSUP:95 ENOTTY:25 ENXIO:6 EOPNOTSUPP:95 EOVERFLOW:75 EPERM:1 EPIPE:32 EPROTO:71 EPROTONOSUPPORT:93 EPROTOTYPE:91 ERANGE:34 EROFS:30 ESPIPE:29 ESRCH:3 ESTALE:116 ETIME:62 ETIMEDOUT:110 ETXTBSY:26 EWOULDBLOCK:11 EXDEV:18";
const SIGNALS = "SIGHUP SIGINT SIGQUIT SIGILL SIGTRAP SIGABRT SIGIOT SIGBUS SIGFPE SIGKILL SIGUSR1 SIGSEGV SIGUSR2 SIGPIPE SIGALRM SIGTERM SIGCHLD SIGSTKFLT SIGCONT SIGSTOP SIGTSTP SIGTTIN SIGTTOU SIGURG SIGXCPU SIGXFSZ SIGVTALRM SIGPROF SIGWINCH SIGIO SIGPOLL SIGPWR SIGSYS";
const SIGNAL_NUMBERS = [1, 2, 3, 4, 5, 6, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 29, 30, 31];

export default {
  EOL: "\n",
  devNull: "/dev/null",
  platform: () => "linux",
  type: () => "Linux",
  arch: () => "x64",
  machine: () => "x86_64",
  release: () => "6.0.0",
  version: () => "#1 SMP",
  hostname: () => "localhost",
  homedir: () => "/home/user",
  tmpdir: () => "/tmp",
  endianness: () => "LE",
  cpus: () => [] as object[],
  availableParallelism: () => 1,
  totalmem: () => 4 * 1024 ** 3,
  freemem: () => 2 * 1024 ** 3,
  uptime: () => Math.round(performance.now() / 1000),
  loadavg: () => [0, 0, 0],
  networkInterfaces: () => ({}),
  userInfo: () => ({ uid: 1000, gid: 1000, username: "user", homedir: "/home/user", shell: null }),
  constants: {
    UV_UDP_REUSEADDR: 4,
    dlopen: { RTLD_LAZY: 1, RTLD_NOW: 2, RTLD_GLOBAL: 256, RTLD_LOCAL: 0, RTLD_DEEPBIND: 8 },
    errno: Object.fromEntries(ERRNO.split(" ").map((e) => e.split(":")).map(([k, v]) => [k, Number(v)])),
    signals: Object.fromEntries(SIGNALS.split(" ").map((s, i) => [s, SIGNAL_NUMBERS[i]])),
    priority: { PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20 },
  },
  getPriority: () => 0,
  setPriority: () => {},
};
