export type ActionIconName =
  | 'back'
  | 'add'
  | 'image'
  | 'crop'
  | 'rotate'
  | 'filter'
  | 'order'
  | 'delete'
  | 'check'
  | 'edit'
  | 'download'
  | 'share'
  | 'camera';

/** Small, consistent touch-toolbar icons; labels remain in the owning controls. */
export function ActionIcon({ name }: { readonly name: ActionIconName }) {
  const paths: Record<ActionIconName, string> = {
    back: 'M15 4l-8 8 8 8',
    add: 'M12 4v16M4 12h16',
    image: 'M3 3h18v18H3zM3 17l6-6 4 4 3-3 5 5M16 7h.01',
    crop: 'M6 2v16h16M2 6h16v16M18 2v4M2 18h4',
    rotate: 'M4 9a8 8 0 1 1 0 6M4 3v6h6',
    filter: 'M9 6h12M3 6h2M15 12h6M3 12h8M9 18h12M3 18h2M7 3v6M13 9v6M7 15v6',
    order: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
    delete: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
    check: 'M4 12l5 5L20 6',
    edit: 'M14 4l6 6M4 20l5-1L21 7l-6-6L3 13z',
    download: 'M12 3v12M6 9l6 6 6-6M4 16v5h16v-5',
    share: 'M12 16V2M7 7l5-5 5 5M6 10H3v11h18V10h-3',
    camera: 'M8 5l2-3h4l2 3h5v16H3V5zM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  };
  return (
    <svg
      className="action-icon"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
