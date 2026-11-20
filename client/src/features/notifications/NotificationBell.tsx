import { Bell, CheckCheck } from "lucide-react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { trpc } from "@/lib/trpc";

export function NotificationBell({ view = "mainnet" }: { view?: "mainnet" | "testnet_archive" }) {
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();
  const notificationsQuery = trpc.notifications.list.useQuery({ view }, {
    refetchInterval: 30_000,
  });
  const markRead = trpc.notifications.markRead.useMutation({
    onSuccess: () => utils.notifications.list.invalidate(),
  });
  const markAllRead = trpc.notifications.markAllRead.useMutation({
    onSuccess: () => utils.notifications.list.invalidate(),
  });
  const items = notificationsQuery.data?.items ?? [];
  const unreadCount = notificationsQuery.data?.unreadCount ?? 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="relative grid h-9 w-9 place-items-center rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          aria-label={unreadCount ? `Notifications, ${unreadCount} unread` : "Notifications"}
        >
          <Bell size={17} />
          {unreadCount > 0 && (
            <span className="absolute -right-1 -top-1 grid min-h-4 min-w-4 place-items-center rounded-full bg-orange-600 px-1 text-[10px] font-bold leading-none text-white">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={10} className="w-[min(24rem,calc(100vw-2rem))] p-0">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <h2 className="text-sm font-bold text-slate-950">Notifications</h2>
            <p className="mt-0.5 text-xs text-slate-600">
              {unreadCount ? `${unreadCount} unread` : "You’re all caught up"}
            </p>
          </div>
          {unreadCount > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto px-2 py-1 text-xs text-orange-800 hover:bg-orange-50"
              disabled={markAllRead.isPending}
              onClick={() => markAllRead.mutate()}
            >
              <CheckCheck size={14} /> Mark all read
            </Button>
          )}
        </div>

        <div className="max-h-[min(26rem,70vh)] overflow-y-auto">
          {notificationsQuery.isLoading ? (
            <p className="px-4 py-8 text-center text-sm text-slate-600">Loading notifications…</p>
          ) : notificationsQuery.isError ? (
            <p className="px-4 py-8 text-center text-sm text-red-700">Couldn’t load notifications. Try again.</p>
          ) : items.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-slate-600">No notifications yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`block w-full px-4 py-3 text-left transition hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none ${item.readAt ? "bg-white" : "bg-orange-50/70"}`}
                    onClick={() => {
                      if (!item.readAt) markRead.mutate({ id: item.id });
                      if (item.href) setLocation(item.href);
                    }}
                  >
                    <span className="flex items-start gap-2">
                      {!item.readAt && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-orange-600" />}
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-slate-950">{item.title}</span>
                        <span className="mt-1 block text-xs leading-5 text-slate-700">{item.body}</span>
                        <span className="mt-1.5 block text-[11px] text-slate-600">
                          {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.createdAt))}
                        </span>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
