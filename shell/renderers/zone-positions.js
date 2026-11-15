export default function render(value) {
  const [first, last] = String(value).split("|");
  if (!/^[1-9]\d*$/.test(first) || !/^[1-9]\d*$/.test(last) || Number(first) > Number(last)) {
    throw new Error(`Invalid zone positions: ${value}`);
  }
  return [first === last ? first : `${first}–${last}`];
}

render;
