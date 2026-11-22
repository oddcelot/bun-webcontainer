import { createMemo, createSignal } from "solid-js";

async function loadRate(currency: string): Promise<{ currency: string; rate: number }> {
  "use server";
  const rates: Record<string, number> = { USD: 1, EUR: 0.92 };
  return { currency, rate: rates[currency] ?? 1 };
}

export default function App() {
  const [count, setCount] = createSignal(0, { name: "count" });
  const double = createMemo(() => count() * 2, { name: "double" });
  const [rate, setRate] = createSignal("");
  return (
    <main>
      <h1 id="title">Solid start mode</h1>
      <button id="inc" onClick={() => setCount((c) => c + 1)}>count {count()} (x2 = {double()})</button>
      <button id="rate" onClick={async () => setRate(JSON.stringify(await loadRate("EUR")))}>call server fn</button>
      <p id="rate-out">{rate()}</p>
    </main>
  );
}
