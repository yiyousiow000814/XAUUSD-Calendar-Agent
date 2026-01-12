from tkinter import Toplevel, ttk

from .constants import APP_ICON, APP_TITLE, UI_COLORS, UI_FONTS, get_asset_path


class LayoutMixin:

    def _build_ui(self) -> None:
        self.root.title(APP_TITLE)
        self.root.geometry("1040x720")
        self.root.configure(bg=UI_COLORS["bg"])
        self.root.minsize(980, 680)
        icon_path = get_asset_path(APP_ICON)
        if icon_path.exists():
            try:
                self.root.iconbitmap(icon_path)
            except Exception:
                pass

        style = ttk.Style(self.root)
        style.theme_use("clam")
        style.configure("Root.TFrame", background=UI_COLORS["bg"])
        style.configure("Card.TFrame", background=UI_COLORS["card"])
        style.configure(
            "Panel.TFrame",
            background=UI_COLORS["card"],
            borderwidth=1,
            relief="solid",
        )
        style.configure("Accent.TFrame", background=UI_COLORS["accent"])
        style.configure(
            "Hero.TLabel",
            background=UI_COLORS["card"],
            foreground=UI_COLORS["ink"],
            font=UI_FONTS["title"],
        )
        style.configure(
            "Subtitle.TLabel",
            background=UI_COLORS["card"],
            foreground=UI_COLORS["muted"],
            font=UI_FONTS["subtitle"],
        )
        style.configure(
            "Section.TLabel",
            background=UI_COLORS["card"],
            foreground=UI_COLORS["ink"],
            font=UI_FONTS["section"],
        )
        style.configure(
            "Body.TLabel",
            background=UI_COLORS["card"],
            foreground=UI_COLORS["ink"],
            font=UI_FONTS["body"],
        )
        style.configure(
            "Muted.TLabel",
            background=UI_COLORS["card"],
            foreground=UI_COLORS["muted"],
            font=UI_FONTS["body"],
        )
        style.configure(
            "StatusText.TLabel",
            background=UI_COLORS["card"],
            foreground=UI_COLORS["muted"],
            font=UI_FONTS["body"],
        )
        style.configure(
            "Status.TLabel",
            background=UI_COLORS["card"],
            foreground=UI_COLORS["ink"],
            font=UI_FONTS["section"],
        )
        style.configure(
            "Primary.TButton",
            font=UI_FONTS["body"],
            foreground="#ffffff",
            background=UI_COLORS["accent"],
            bordercolor=UI_COLORS["accent"],
            focusthickness=0,
            padding=(12, 6),
        )
        style.map(
            "Primary.TButton",
            background=[("active", UI_COLORS["accent_dark"])],
        )
        style.configure(
            "Secondary.TButton",
            font=UI_FONTS["body"],
            foreground=UI_COLORS["ink"],
            background=UI_COLORS["card"],
            bordercolor=UI_COLORS["border"],
            focusthickness=0,
            padding=(12, 6),
        )
        style.map(
            "Secondary.TButton",
            background=[("active", UI_COLORS["shadow"])],
        )
        style.configure(
            "Ghost.TButton",
            font=UI_FONTS["body"],
            foreground=UI_COLORS["muted"],
            background=UI_COLORS["card"],
            bordercolor=UI_COLORS["border"],
            focusthickness=0,
            padding=(12, 6),
        )
        style.map(
            "Ghost.TButton",
            background=[("active", UI_COLORS["shadow"])],
        )
        style.configure(
            "TCheckbutton",
            background=UI_COLORS["card"],
            font=UI_FONTS["body"],
        )
        style.configure(
            "TEntry",
            fieldbackground=UI_COLORS["card"],
            bordercolor=UI_COLORS["border"],
            padding=6,
        )
        style.configure(
            "TCombobox",
            fieldbackground=UI_COLORS["card"],
            foreground=UI_COLORS["ink"],
            bordercolor=UI_COLORS["border"],
            padding=4,
        )
        style.map(
            "TCombobox",
            fieldbackground=[("readonly", UI_COLORS["card"])],
            foreground=[("readonly", UI_COLORS["ink"])],
        )
        style.configure(
            "Treeview",
            background=UI_COLORS["card"],
            fieldbackground=UI_COLORS["card"],
            foreground=UI_COLORS["ink"],
            rowheight=28,
            bordercolor=UI_COLORS["border"],
            borderwidth=1,
            relief="solid",
        )
        style.map(
            "Treeview",
            background=[("selected", UI_COLORS["accent_soft"])],
            foreground=[("selected", UI_COLORS["ink"])],
        )
        style.configure(
            "Treeview.Heading",
            font=UI_FONTS["body"],
            background=UI_COLORS["header"],
            foreground=UI_COLORS["muted"],
            borderwidth=1,
            relief="solid",
            padding=(8, 4),
        )

        container = ttk.Frame(self.root, style="Root.TFrame")
        container.grid(row=0, column=0, sticky="nsew")
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        container.columnconfigure(0, weight=1)
        container.rowconfigure(2, weight=1)
        container.rowconfigure(3, weight=2)

        accent = ttk.Frame(container, style="Accent.TFrame", height=4)
        accent.grid(row=0, column=0, sticky="ew")

        hero = ttk.Frame(container, style="Panel.TFrame")
        hero.grid(row=1, column=0, sticky="ew", padx=16, pady=(16, 16))
        hero.columnconfigure(1, weight=1)
        hero_accent = ttk.Frame(hero, style="Accent.TFrame", width=6)
        hero_accent.grid(row=0, column=0, sticky="ns", rowspan=2, padx=(0, 16))
        ttk.Label(hero, text=APP_TITLE, style="Hero.TLabel").grid(
            row=0, column=1, sticky="w", pady=(12, 0)
        )
        ttk.Label(
            hero,
            text="Economic calendar sync, pull automation, and mirror delivery.",
            style="Subtitle.TLabel",
        ).grid(row=1, column=1, sticky="w", pady=(6, 12))
        hero_status = ttk.Frame(hero, style="Card.TFrame")
        hero_status.grid(
            row=0, column=2, rowspan=2, sticky="ne", padx=(0, 16), pady=(12, 0)
        )
        hero_status.columnconfigure(0, weight=0)
        hero_status.columnconfigure(1, weight=1)
        ttk.Label(hero_status, text="Last Pull", style="Muted.TLabel").grid(
            row=0, column=0, sticky="w", padx=(0, 8), pady=(0, 6)
        )
        ttk.Label(
            hero_status, textvariable=self.last_pull_var, style="Body.TLabel"
        ).grid(row=0, column=1, sticky="w", pady=(0, 6))
        ttk.Label(hero_status, text="Last Sync", style="Muted.TLabel").grid(
            row=1, column=0, sticky="w", padx=(0, 8)
        )
        ttk.Label(
            hero_status, textvariable=self.last_sync_var, style="Body.TLabel"
        ).grid(row=1, column=1, sticky="w")

        main = ttk.Frame(container, style="Root.TFrame")
        main.grid(row=2, column=0, sticky="nsew", padx=16, pady=(0, 16))
        main.columnconfigure(0, weight=1)
        main.columnconfigure(1, weight=2)
        main.rowconfigure(0, weight=1)

        left_panel = ttk.Frame(main, style="Root.TFrame")
        left_panel.grid(row=0, column=0, sticky="nsew", padx=(0, 16))
        left_panel.columnconfigure(0, weight=1)
        left_panel.rowconfigure(0, weight=1)
        left_panel.rowconfigure(1, weight=1)

        left_actions = ttk.Frame(left_panel, style="Panel.TFrame")
        left_actions.grid(row=0, column=0, sticky="nsew", pady=(0, 16))
        ttk.Label(left_actions, text="Quick Actions", style="Section.TLabel").grid(
            row=0, column=0, sticky="w", padx=12, pady=(12, 8)
        )
        action_row = ttk.Frame(left_actions, style="Card.TFrame")
        action_row.grid(row=1, column=0, sticky="w", padx=12, pady=(0, 12))
        ttk.Button(
            action_row,
            text="Pull Now",
            command=self._pull_now,
            style="Primary.TButton",
            width=12,
        ).grid(row=0, column=0, padx=(0, 8))
        ttk.Button(
            action_row,
            text="Sync Now",
            command=self._sync_now,
            style="Secondary.TButton",
            width=12,
        ).grid(row=0, column=1, padx=(0, 8))
        ttk.Button(
            action_row,
            text="Settings",
            command=self._open_settings,
            style="Secondary.TButton",
            width=12,
        ).grid(row=0, column=2)

        left_dest = ttk.Frame(left_panel, style="Panel.TFrame")
        left_dest.grid(row=1, column=0, sticky="nsew")
        left_dest.columnconfigure(0, weight=1)
        ttk.Label(left_dest, text="Destination", style="Section.TLabel").grid(
            row=0, column=0, sticky="w", padx=12, pady=(12, 8)
        )
        ttk.Label(left_dest, text="Calendar Output", style="Muted.TLabel").grid(
            row=1, column=0, sticky="w", padx=12, pady=(0, 6)
        )
        output_row = ttk.Frame(left_dest, style="Card.TFrame")
        output_row.grid(row=2, column=0, sticky="ew", padx=12, pady=(0, 12))
        output_row.columnconfigure(0, weight=1)
        ttk.Entry(output_row, textvariable=self.output_var).grid(
            row=0, column=0, sticky="ew"
        )
        ttk.Button(
            output_row,
            text="Browse",
            command=self._browse_output,
            style="Secondary.TButton",
        ).grid(row=0, column=1, padx=(8, 0))
        ttk.Button(
            output_row, text="Save", command=self._save_paths, style="Secondary.TButton"
        ).grid(row=0, column=2, padx=(8, 0))

        right_activity = ttk.Frame(main, style="Panel.TFrame")
        right_activity.grid(row=0, column=1, sticky="nsew")
        right_activity.columnconfigure(0, weight=1)
        right_activity.rowconfigure(1, weight=1)
        activity_header = ttk.Frame(right_activity, style="Card.TFrame")
        activity_header.grid(row=0, column=0, sticky="ew", padx=12, pady=(12, 8))
        activity_header.columnconfigure(0, weight=1)
        ttk.Label(activity_header, text="Activity Log", style="Section.TLabel").grid(
            row=0, column=0, sticky="w"
        )
        activity_controls = ttk.Frame(activity_header, style="Card.TFrame")
        activity_controls.grid(row=0, column=1, sticky="e")
        ttk.Label(activity_controls, text="Filter", style="Muted.TLabel").grid(
            row=0, column=0, padx=(0, 8)
        )
        self.log_filter_combo = ttk.Combobox(
            activity_controls,
            textvariable=self.log_filter_var,
            values=["All", "Info", "Warn", "Error"],
            width=8,
            state="readonly",
        )
        self.log_filter_combo.grid(row=0, column=1, padx=(0, 8))
        ttk.Button(
            activity_controls,
            text="Clear",
            command=self._clear_notice_log,
            style="Secondary.TButton",
        ).grid(row=0, column=2)
        self.notice_list = ttk.Treeview(
            right_activity,
            columns=("level", "time", "event"),
            show="headings",
            height=12,
        )
        self.notice_list.heading("level", text="Level", anchor="center")
        self.notice_list.heading("time", text="Time", anchor="w")
        self.notice_list.heading("event", text="Event", anchor="w")
        self.notice_list.column("level", width=60, anchor="center", stretch=False)
        self.notice_list.column("time", width=140, anchor="w", stretch=False)
        self.notice_list.column("event", anchor="w", stretch=True, width=1)
        self.notice_list.grid(row=1, column=0, sticky="nsew", padx=12, pady=(0, 12))
        self.notice_list.tag_configure("log_info", foreground=UI_COLORS["info"])
        self.notice_list.tag_configure("log_warn", foreground=UI_COLORS["warn"])
        self.notice_list.tag_configure("log_error", foreground=UI_COLORS["error"])

        right_calendar = ttk.Frame(container, style="Panel.TFrame")
        right_calendar.grid(row=3, column=0, sticky="nsew", padx=16, pady=(0, 16))
        right_calendar.columnconfigure(0, weight=1)
        right_calendar.rowconfigure(2, weight=1)
        calendar_header = ttk.Frame(right_calendar, style="Card.TFrame")
        calendar_header.grid(row=0, column=0, sticky="ew", padx=12, pady=(12, 8))
        calendar_header.columnconfigure(0, weight=1)
        ttk.Label(calendar_header, text="Next Events", style="Section.TLabel").grid(
            row=0, column=0, sticky="w"
        )
        filter_row = ttk.Frame(calendar_header, style="Card.TFrame")
        filter_row.grid(row=0, column=1, sticky="e", pady=(2, 0))
        ttk.Label(filter_row, text="Currency", style="Muted.TLabel").grid(
            row=0, column=0, padx=(0, 8)
        )
        self.currency_combo = ttk.Combobox(
            filter_row,
            textvariable=self.currency_var,
            values=["USD", "ALL"],
            width=8,
            state="readonly",
        )
        self.currency_combo.grid(row=0, column=1)

        self.calendar_list = ttk.Treeview(
            right_calendar,
            columns=("time", "cur", "imp", "event", "countdown"),
            show="headings",
            height=12,
        )
        self.calendar_list.heading("time", text="Time", anchor="w")
        self.calendar_list.heading("cur", text="Cur", anchor="center")
        self.calendar_list.heading("imp", text="Impact", anchor="center")
        self.calendar_list.heading("event", text="Event", anchor="w")
        self.calendar_list.heading("countdown", text="Countdown", anchor="e")
        self.calendar_list.column("time", width=140, anchor="w", stretch=False)
        self.calendar_list.column("cur", width=60, anchor="center", stretch=False)
        self.calendar_list.column("imp", width=90, anchor="center", stretch=False)
        self.calendar_list.column("event", anchor="w", stretch=True, width=1)
        self.calendar_list.column("countdown", width=110, anchor="e", stretch=False)
        self.calendar_list.grid(row=2, column=0, sticky="nsew", padx=12, pady=(0, 12))
        self.calendar_list.tag_configure("imp_high", foreground=UI_COLORS["error"])
        self.calendar_list.tag_configure("imp_medium", foreground=UI_COLORS["warn"])
        self.calendar_list.tag_configure("imp_low", foreground=UI_COLORS["info"])
        self.calendar_list.tag_configure("imp_holiday", foreground="#6b7280")

    def _center_window(self, window: Toplevel) -> None:
        window.update_idletasks()
        width = window.winfo_width()
        height = window.winfo_height()
        parent_x = self.root.winfo_rootx()
        parent_y = self.root.winfo_rooty()
        parent_w = self.root.winfo_width()
        parent_h = self.root.winfo_height()
        x = parent_x + max((parent_w - width) // 2, 0)
        y = parent_y + max((parent_h - height) // 2, 0)
        window.geometry(f"+{x}+{y}")

    def _finalize_settings_window(self, window: Toplevel) -> None:
        window.update_idletasks()
        req_width = max(window.winfo_reqwidth(), 760)
        req_height = max(window.winfo_reqheight(), 700)
        window.geometry(f"{req_width}x{req_height}")
        self._center_window(window)
        window.deiconify()
