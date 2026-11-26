export const validShippingZip = (value: unknown): value is string => typeof value === "string" && /^\d{5}(?:-\d{4})?$/.test(value);
