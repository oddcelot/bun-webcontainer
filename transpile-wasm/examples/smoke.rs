use bun_transpile_wasm::{Loader, transpile};

fn main() {
    let cases: &[(&str, &[u8], Loader)] = &[
        ("a.ts", b"const x: number = 1;\nexport function f<T>(a: T): T { return a }\nenum E { A, B }\n", Loader::Ts),
        ("a.tsx", b"export const App = ({ n }: { n: number }) => <div class=\"x\">{n}</div>;\n", Loader::Tsx),
        ("a.js", b"import { a } from './b'; console.log(`hi ${a}`, 0xFF, 1_000)\n", Loader::Js),
        ("bad.ts", b"let = ;\n", Loader::Ts),
    ];
    for (path, src, loader) in cases {
        match transpile(path.as_bytes(), src, *loader, 0) {
            Ok(out) => println!("== {path} OK\n{}", String::from_utf8_lossy(&out)),
            Err(e) => println!("== {path} ERR\n{}", String::from_utf8_lossy(&e)),
        }
    }
}
