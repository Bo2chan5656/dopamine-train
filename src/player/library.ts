export interface VideoItem {
  readonly id: string;
  readonly url: string; // object URL
  readonly name: string;
}

export interface Library {
  readonly items: readonly VideoItem[];
  addFiles(files: FileList | readonly File[]): void;
  /** 全アイテムを破棄し、object URL を revoke する。 */
  clear(): void;
}

/**
 * ローカル動画ファイルの読み込み。input[type=file] を root に追加し、選択された
 * ファイルから object URL を作る。YouTube 等の外部APIやIFrame Player は使わない
 * （規約リスクを最小化する自前プレイヤー方針）。
 */
export function createLibrary(root: HTMLElement, onChange: (items: readonly VideoItem[]) => void): Library {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'video/*';
  input.multiple = true;
  input.style.display = 'block';
  input.style.margin = '0.5rem auto';
  input.style.color = '#f5f5f5';
  root.appendChild(input);

  let items: VideoItem[] = [];
  let nextId = 0;

  function addFiles(files: FileList | readonly File[]): void {
    const added = Array.from(files)
      .filter((f) => f.type.startsWith('video/'))
      .map((f) => ({ id: `v${++nextId}`, url: URL.createObjectURL(f), name: f.name }));
    if (added.length === 0) return;
    items = [...items, ...added];
    onChange(items);
  }

  function clear(): void {
    for (const item of items) URL.revokeObjectURL(item.url);
    items = [];
    onChange(items);
  }

  input.addEventListener('change', () => {
    if (input.files) addFiles(input.files);
    input.value = ''; // 同じファイルを選び直せるようにする
  });

  return {
    get items() {
      return items;
    },
    addFiles,
    clear,
  };
}
