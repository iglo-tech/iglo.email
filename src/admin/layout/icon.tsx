// listmonk cmd/init.go Icon: a symbol from the embedded feather sprite.
export function Icon({ name, file = "icons.svg" }: { name: string; file?: string }) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new TypeError("Invalid icon name");
  return (
    <svg class="icon">
      <use href={`/admin/static/${file}#icon-${name}`}></use>
    </svg>
  );
}
