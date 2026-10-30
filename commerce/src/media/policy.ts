/** Reviewed publication policy: processed bytes exist only after OWNER publication.
 * The separately enrolled worker can read private originals, but cannot widen bucket access.
 * Cloud.ru bucket roles remain necessary; policy never substitutes for those roles.
 */
export function publicVariantPolicy(bucket: string, principalArn?: string) {
  const variants = [480, 960, 1600].map(
    (width) => `arn:aws:s3:::${bucket}/media/v1/*/*/${width}.webp`,
  );
  const Statement: Record<string, unknown>[] = [{
    Sid: 'PublicProcessedWebpOnly', Effect: 'Allow', Principal: '*',
    Action: 's3:GetObject', Resource: variants,
  }];
  if (principalArn) {
    const Principal = { AWS: principalArn };
    const Action = ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'];
    const Resource = [`arn:aws:s3:::${bucket}/media/v1/*/*/original`, ...variants];
    Statement.push(
      { Sid: 'MediaWorkerKnownObjects', Effect: 'Allow', Principal, Action, Resource },
      { Sid: 'MediaWorkerKnownKeysOnly', Effect: 'Deny', Principal, Action, NotResource: Resource },
      {
        Sid: 'MediaWorkerNoBucketMutation', Effect: 'Deny', Principal,
        Action: ['s3:CreateBucket', 's3:DeleteBucket', 's3:PutBucket*', 's3:DeleteBucket*',
          's3:PutPublicAccessBlock', 's3:DeletePublicAccessBlock'],
        Resource: `arn:aws:s3:::${bucket}`,
      },
    );
  }
  return { Version: '2012-10-17', Statement };
}
const values = (v: unknown) => Array.isArray(v) ? v : [v];
const equalSet = (a: unknown, b: unknown) =>
  JSON.stringify([...values(a)].sort()) === JSON.stringify([...values(b)].sort());
function equivalent(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  // Evolution canonicalizes unset fields to empty collections. Nonempty alternatives/conditions
  // must never silently widen an Allow or narrow a required Deny.
  return Object.keys(actual).every((key) => {
    if (key === 'Sid') return true;
    if (key in expected) return key === 'Action' || key === 'Resource' || key === 'NotResource'
      ? equalSet(actual[key], expected[key])
      : JSON.stringify(actual[key]) === JSON.stringify(expected[key]);
    const value = actual[key];
    if (['NotAction', 'NotResource', 'Resource'].includes(key))
      return Array.isArray(value) && value.length === 0;
    if (['NotPrincipal', 'Condition'].includes(key))
      return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
    return false;
  }) && Object.keys(expected).filter((key) => key !== 'Sid').every((key) => key in actual);
}
export function assertPublicVariantPolicy(raw: string | undefined, bucket: string, principalArn?: string): void {
  if (!raw) throw new Error('MEDIA_POLICY_UNCONFIRMED');
  const policy = JSON.parse(raw) as { Version?: unknown; Statement?: unknown };
  if (policy.Version !== '2012-10-17' || !Array.isArray(policy.Statement))
    throw new Error('MEDIA_POLICY_UNCONFIRMED');
  const statements = policy.Statement as Record<string, unknown>[];
  if (statements.some((s) => !s || typeof s !== 'object' || !['Allow', 'Deny'].includes(String(s.Effect))))
    throw new Error('MEDIA_POLICY_UNCONFIRMED');
  const expected = publicVariantPolicy(bucket, principalArn).Statement;
  if (statements.filter((s) => s.Effect === 'Allow').length !== expected.filter((s) => s.Effect === 'Allow').length
    || expected.some((e) => !statements.some((s) => equivalent(s, e))))
    throw new Error('MEDIA_POLICY_UNCONFIRMED');
  // Additional Deny rules only restrict access. Runtime byte read-back still has to succeed.
}
