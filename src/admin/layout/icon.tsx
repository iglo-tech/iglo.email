// listmonk cmd/init.go Icon: a symbol from the embedded feather sprite.
export function Icon({ name }: { name: string }) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new TypeError("Invalid icon name");
  return (
    <svg class="icon">
      <use href={`/admin/static/icons.svg#icon-${name}`}></use>
    </svg>
  );
}
