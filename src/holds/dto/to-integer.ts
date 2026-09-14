export const toInteger = (value: unknown): unknown => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value
    ? parsed
    : value;
};
