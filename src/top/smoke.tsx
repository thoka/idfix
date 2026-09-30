// Step 8b smoke test: does Ink 7.1.1 work under bun 1.4.2?
// Renders a counter, handles j/k/q through useInput, shows the window size.
import { render, Text, Box, useApp, useInput, useWindowSize } from "ink";
import React, { useState } from "react";

export function Smoke() {
  const [count, setCount] = useState(0);
  const size = useWindowSize();
  const { exit } = useApp();

  useInput((input) => {
    if (input === "j") setCount((c) => c + 1);
    if (input === "k") setCount((c) => c - 1);
    if (input === "q") exit();
  });

  return (
    <Box flexDirection="column">
      <Text>count: {count}</Text>
      <Text dimColor>
        j/k to change, q to quit ({size.columns}x{size.rows})
      </Text>
    </Box>
  );
}

if (import.meta.main) {
  const { waitUntilExit } = render(<Smoke />, { alternateScreen: true });
  await waitUntilExit();
}
