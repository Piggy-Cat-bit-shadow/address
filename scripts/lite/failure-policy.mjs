const failures = (error) => error instanceof AggregateError && Array.isArray(error.errors)
  ? error.errors
  : [error];

export const emptyResidentialFailure = (error) => {
  const causes = failures(error);
  return causes.length > 0 && causes.every((cause) =>
    cause?.code === 'SOURCE_QUALITY_FAILED'
    && /produced no valid addresses$/u.test(String(cause?.message || ''))
  );
};

export const emptyResidentialMetrics = (error) => {
  const rejectedCount = failures(error).reduce((total, cause) => total
    + Object.values(cause?.rejectionReasons || {}).reduce((sum, count) => sum + Number(count || 0), 0), 0);
  return { acceptedCount: 0, rejectedCount };
};
