import { AGILEPREDICT_MODEL } from '@octoprice/core';
import type { JSX } from 'react';

export function AgilePredictCredit(): JSX.Element {
  return (
    <>
      Forecasts by AgilePredict. Contains BMRS data © Elexon Limited copyright and database right.
      Supported by National Energy SO Open Data. Weather data by Open-Meteo.com.
    </>
  );
}

export function ForecastSourceNote({
  source,
  issuedAt,
}: {
  source: string | undefined;
  issuedAt: string | undefined;
}): JSX.Element {
  if (source !== AGILEPREDICT_MODEL) {
    return (
      <p className="forecast-note muted small">
        Experimental v1 estimate from recent confirmed Agile prices.
      </p>
    );
  }
  const issue = issuedAt
    ? new Date(issuedAt).toLocaleString('en-GB', {
        timeZone: 'Europe/London',
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;
  return (
    <p className="forecast-note muted small">
      AgilePredict estimate{issue ? ` issued ${issue}` : ''}. The range shown is the provider’s own
      range, not a verified confidence interval. <AgilePredictCredit />
    </p>
  );
}
