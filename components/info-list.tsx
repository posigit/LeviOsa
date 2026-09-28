import type { ReactNode } from "react";

export type InfoListItem = {
  label: string;
  value: ReactNode;
};

/** Apple-TV-style label-over-value facts list. Last section on a detail page. */
export function InfoList({
  items,
  className = "mt-7",
}: {
  items: InfoListItem[];
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <section className={className}>
      <h2 className="mb-3 text-[22px] font-extrabold tracking-tight text-white">
        Information
      </h2>
      <div className="space-y-4">
        {items.map((item) => (
          <div key={item.label}>
            <p className="text-[15px] leading-tight text-white/45">
              {item.label}
            </p>
            <p className="mt-1 text-[19px] font-medium leading-snug text-white [overflow-wrap:anywhere]">
              {item.value}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
