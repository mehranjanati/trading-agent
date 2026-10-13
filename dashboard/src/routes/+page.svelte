<script lang="ts">
  import DataPage from "$lib/components/DataPage.svelte";
  import { getHealth, badgeFor } from "$lib/api";
  import { onMount } from "svelte";

  export let data: { result: any } = { result: null };
  let result: any = data?.result ?? null;

  async function refresh() { result = await getHealth(); }
  onMount(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  });

  $: cards = (result?.ok ? result.data.components : []).map((c: any) => ({ component: c.component, status: c.status }));
  $: overall = badgeFor(result);
</script>

<DataPage title="overview" result={result} badge={overall} columns={[
  { key: "component", label: "component" }, { key: "status", label: "status" },
]} rows={cards} />