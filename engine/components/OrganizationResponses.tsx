/**
 * An organization's responses, beside the accounts they answer.
 *
 * Never above them and never instead of them: the response is labelled as the
 * organization's account, and the experience it answers stays exactly where it
 * was. A `dispute` in particular is shown as a disagreement between two accounts,
 * not as a correction of the first.
 */
export interface ResponseView {
  readonly responseId: string;
  readonly organizationName: string;
  readonly kind: string;
  readonly body: string;
  readonly respondedAt: number;
}

const KIND_LABELS: Readonly<Record<string, string>> = {
  acknowledge: 'acknowledged this',
  respond: 'responded',
  publish_resolution: 'says this was fixed',
  service_update: 'posted an update',
  dispute: 'disputes this account',
  known_incident: 'says this was a known incident',
  remediation_instructions: 'explained what to do',
};

export const OrganizationResponses = ({ responses }: { responses: readonly ResponseView[] }) => {
  if (responses.length === 0) return null;
  return (
    <div className="org-responses">
      {responses.map((response) => (
        <div className="org-response" key={response.responseId}>
          <p className="org-response-head">
            <strong>{response.organizationName}</strong> {KIND_LABELS[response.kind] ?? 'responded'}
          </p>
          <p className="org-response-body">{response.body}</p>
        </div>
      ))}
    </div>
  );
};
