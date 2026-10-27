import { useState } from "react";
export default function App({ items }: { items: string[] }) {
  const [n, setN] = useState(0);
  return <>
    <button onClick={() => setN(n + 1)} disabled={n > 3}>clicked {n}x</button>
    <ul>{items.map((i) => <li key={i} {...{ title: i }}>{i}</li>)}</ul>
  </>;
}
