import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center gap-4 px-4 py-24 text-center">
      <p className="font-heading text-sm font-semibold tracking-widest text-primary uppercase">404</p>
      <h1 className="font-heading text-3xl font-semibold text-foreground sm:text-4xl">Страница не найдена</h1>
      <p className="text-muted-foreground">
        Такой страницы не существует или она была перемещена. Возможно, направление или отчёт, на который вы
        перешли, больше не опубликованы.
      </p>
      <Link href="/" className={cn(buttonVariants({ variant: "default" }), "mt-2")}>
        На главную
      </Link>
    </div>
  );
}
