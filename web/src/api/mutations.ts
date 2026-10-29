import { useMutation, useQueryClient } from "@tanstack/react-query";

/**
 * A write to the API (`postJson`, `putJson`, `deleteJson`) as the control that makes it uses it: `mutate(variables)` runs `write`, and the
 * result says whether it is on its way (`isPending`: the control shows it), has failed (`error`, an `ApiError` for an answer that was
 * not a success: the control shows it with a Retry, which is `mutate(variables)` again with the same `variables`) or went through.
 *
 * Every query is invalidated when a write goes through, with no filter (global constraints, Web writes): what is on screen is asked for
 * again, and the rest is marked stale and asked for when it is next shown. A write changes things (a place's name, the trips, the days)
 * far beyond the one thing it was made to, and no list of what to ask for again would stay right. It does not wait for those requests: the
 * write is done when the server says so, and a heat or a range that is slow to come back is no reason to keep the control pending. A write
 * that fails invalidates nothing, for nothing has changed.
 */
export function useWrite<TVariables = void, TData = void>(write: (variables: TVariables) => Promise<TData>) {
  const queryClient = useQueryClient();
  return useMutation<TData, Error, TVariables>({
    mutationFn: write,
    onSuccess: () => {
      void queryClient.invalidateQueries();
    },
  });
}
