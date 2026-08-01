/**
 * The output side. One group, one heading, one or two rows — the count is the
 * whole point: bridge_plus_refuel receives two things, bridge_only receives one.
 */
export function ReceiveGroup({ title, children }) {
  return (
    <section class="compose-receive" aria-label={title}>
      <p class="compose-receive__head">
        <span>{title}</span>
      </p>
      <div class="compose-receive__rows">{children}</div>
    </section>
  );
}
