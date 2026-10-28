import { createSignal } from "solid-js";

export default function Counter(props: { start: number }) {
  const [count, setCount] = createSignal(props.start);
  return (
    <div class="counter">
      <button onClick={() => setCount(count() - 1)}>-</button>
      <output>{count()}</output>
      <button onClick={() => setCount(count() + 1)}>+</button>
    </div>
  );
}
