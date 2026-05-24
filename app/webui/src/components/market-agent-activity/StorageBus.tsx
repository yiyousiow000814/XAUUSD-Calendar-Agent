import type { StorageGroup } from "./signalMapModel";

type StorageBusProps = {
  groups: StorageGroup[];
  path: string;
};

export function StorageBus({ groups, path }: StorageBusProps) {
  return (
    <section className="market-agent-storage-bus" aria-label="Storage Bus">
      <header>
        <div>
          <span>Storage Bus</span>
          <h3>TimelineStore persistence</h3>
        </div>
        <em>{path}</em>
      </header>
      <div className="market-agent-storage-bus-rail" aria-hidden="true" />
      <div className="market-agent-storage-bus-groups">
        {groups.map((group) => (
          <section key={group.title}>
            <strong>{group.title}</strong>
            <p>{group.detail}</p>
            <div>
              {group.tables.map((table) => (
                <span key={table}>{table}</span>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}
