// Loaded before every test file: any fetch that a test did not fake fails loudly instead of touching the network.
globalThis.fetch = (async (input: unknown) => {
  throw new Error("network access in a test: " + String(input));
}) as typeof fetch;
