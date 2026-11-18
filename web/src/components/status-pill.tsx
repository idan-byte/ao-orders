import type { ComponentProps } from "react";
import type { Tone } from "@/lib/status-tone";

// A status shown as a coloured label. The colour comes from the tone, the words from the status itself.
export function StatusPill({ tone, className = "", ...rest }: ComponentProps<"span"> & { tone: Tone }) {
  return <span {...rest} data-tone={tone} className={`status-pill ${className}`.trim()} />;
}
