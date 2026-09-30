# -*- coding: utf-8 -*-
"""
STEP 3 - Average daily frequency per shape.

The script automatically recognizes the model used by the GTFS feed.

CASE A: frequencies.txt populated
---------------------------------
1. Reads the patterns present in frequencies.txt.
2. Computes the trips generated in each time band:

       corse_fascia = ceil(
           (end_time - start_time) / headway_secs
       )

3. Links the frequencies to the trips and to the shapes.
4. Removes the equivalent patterns to avoid double counting.
5. Multiplies the daily trips by the active dates of the service_id.

CASE B: frequencies.txt missing, empty or without valid time bands
------------------------------------------------------------------
1. Each trip_id in trips.txt represents a scheduled trip.
2. Each trip is counted once for each active date of the service_id.

CALENDAR
--------
In both cases:

- calendar.txt defines the active weekdays;
- calendar_dates.txt applies the exceptions:
      exception_type = 1 -> addition
      exception_type = 2 -> removal

The average daily frequency is computed over the entire GTFS period:

    freq_giornaliera =
        passaggi_totali / numero_giorni_periodo

The number of days in the period is computed automatically.

OUTPUT
------
output/frequenza_shape.csv

Columns:
    shape_id
    passaggi_totali
    freq_giornaliera
"""

import math
import os
from datetime import datetime, timedelta

import pandas as pd
from pandas.errors import EmptyDataError

import _common as C


# ===========================================================================
# General functions
# ===========================================================================

def parse_data_gtfs(valore):
    """Converts a GTFS date YYYYMMDD into a datetime.date."""
    return datetime.strptime(str(valore).strip(), "%Y%m%d").date()


def tempo_in_secondi(valore):
    """
    Converts a GTFS time HH:MM:SS into seconds.

    It also supports hours greater than 23, for example 25:30:00.
    """
    try:
        ore, minuti, secondi = map(
            int,
            str(valore).strip().split(":")
        )

        return ore * 3600 + minuti * 60 + secondi

    except (ValueError, TypeError, AttributeError):
        return None


def intervallo_date(data_inizio, data_fine):
    """Generates all dates between data_inizio and data_fine, endpoints included."""
    data = data_inizio

    while data <= data_fine:
        yield data
        data += timedelta(days=1)


# ===========================================================================
# GTFS Calendar
# ===========================================================================

def calcola_date_attive():
    """
    Computes the actually active dates for each service_id.

    Applies:
    - the base calendar from calendar.txt;
    - the additions and removals from calendar_dates.txt.

    Returns:
        date_attive:
            dictionary service_id -> set of active dates

        inizio_periodo:
            overall first date of the GTFS

        fine_periodo:
            overall last date of the GTFS
    """

    if not os.path.isfile(C.F_CALENDAR):
        raise FileNotFoundError(
            f"Mandatory file not found: {C.F_CALENDAR}"
        )

    C.log(f"Reading {C.F_CALENDAR}")

    cal = pd.read_csv(
        C.F_CALENDAR,
        dtype=str
    )

    colonne_obbligatorie = [
        "service_id",
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
        "start_date",
        "end_date",
    ]

    colonne_mancanti = [
        colonna
        for colonna in colonne_obbligatorie
        if colonna not in cal.columns
    ]

    if colonne_mancanti:
        raise ValueError(
            "Missing columns in calendar.txt: "
            + ", ".join(colonne_mancanti)
        )

    if cal.empty:
        raise ValueError("calendar.txt is empty.")

    weekday_cols = [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
    ]

    for colonna in weekday_cols:
        cal[colonna] = pd.to_numeric(
            cal[colonna],
            errors="coerce"
        ).fillna(0).astype(int)

    cal["service_id"] = cal["service_id"].fillna("").str.strip()

    cal["data_inizio"] = (
        cal["start_date"].apply(parse_data_gtfs)
    )

    cal["data_fine"] = (
        cal["end_date"].apply(parse_data_gtfs)
    )

    date_attive = {}

    # -----------------------------------------------------------------------
    # Base calendar
    # -----------------------------------------------------------------------

    for _, riga in cal.iterrows():

        service_id = riga["service_id"]

        if not service_id:
            continue

        data_inizio = riga["data_inizio"]
        data_fine = riga["data_fine"]

        giorni_settimana = [
            riga[colonna]
            for colonna in weekday_cols
        ]

        date_service = date_attive.setdefault(
            service_id,
            set()
        )

        for data in intervallo_date(
            data_inizio,
            data_fine
        ):
            # weekday(): Monday = 0, Sunday = 6
            if giorni_settimana[data.weekday()] == 1:
                date_service.add(data)

    # The initial endpoints come from calendar.txt.
    date_estremi = (
        cal["data_inizio"].tolist()
        + cal["data_fine"].tolist()
    )

    # -----------------------------------------------------------------------
    # Exceptions from calendar_dates.txt
    # -----------------------------------------------------------------------

    if (
        os.path.isfile(C.F_CALENDAR_DATES)
        and os.path.getsize(C.F_CALENDAR_DATES) > 0
    ):
        C.log(f"Reading {C.F_CALENDAR_DATES}")

        try:
            calendar_dates = pd.read_csv(
                C.F_CALENDAR_DATES,
                dtype=str
            )
        except EmptyDataError:
            calendar_dates = pd.DataFrame()

        if calendar_dates.empty:
            C.log(
                "calendar_dates.txt is empty: "
                "using only calendar.txt"
            )

        else:
            colonne_eccezioni = [
                "service_id",
                "date",
                "exception_type",
            ]

            mancanti = [
                colonna
                for colonna in colonne_eccezioni
                if colonna not in calendar_dates.columns
            ]

            if mancanti:
                raise ValueError(
                    "Missing columns in calendar_dates.txt: "
                    + ", ".join(mancanti)
                )

            calendar_dates["service_id"] = (
                calendar_dates["service_id"]
                .fillna("")
                .str.strip()
            )

            calendar_dates["data_eccezione"] = (
                calendar_dates["date"]
                .apply(parse_data_gtfs)
            )

            for _, riga in calendar_dates.iterrows():

                service_id = riga["service_id"]
                data = riga["data_eccezione"]

                exception_type = (
                    str(riga["exception_type"]).strip()
                )

                if not service_id:
                    continue

                date_service = date_attive.setdefault(
                    service_id,
                    set()
                )

                if exception_type == "1":
                    date_service.add(data)

                elif exception_type == "2":
                    date_service.discard(data)

                else:
                    C.log(
                        "WARNING: unrecognized exception_type "
                        f"for service_id={service_id}, "
                        f"date={data}: {exception_type}"
                    )

            # The exceptions too take part in defining
            # the overall temporal endpoints of the feed.
            date_estremi.extend(
                calendar_dates["data_eccezione"].tolist()
            )

    else:
        C.log(
            "calendar_dates.txt missing or empty: "
            "using only calendar.txt"
        )

    if not date_estremi:
        raise ValueError(
            "Unable to determine the temporal period of the GTFS."
        )

    inizio_periodo = min(date_estremi)
    fine_periodo = max(date_estremi)

    return date_attive, inizio_periodo, fine_periodo


# ===========================================================================
# Reading trips.txt
# ===========================================================================

def leggi_trips():
    """
    Reads trips.txt keeping the necessary attributes.

    direction_id is read only if present.
    """

    if not os.path.isfile(C.F_TRIPS):
        raise FileNotFoundError(
            f"Mandatory file not found: {C.F_TRIPS}"
        )

    C.log(f"Reading {C.F_TRIPS}")

    header_trips = pd.read_csv(
        C.F_TRIPS,
        nrows=0
    ).columns.tolist()

    colonne_obbligatorie = [
        "route_id",
        "service_id",
        "trip_id",
        "shape_id",
    ]

    mancanti = [
        colonna
        for colonna in colonne_obbligatorie
        if colonna not in header_trips
    ]

    if mancanti:
        raise ValueError(
            "Missing columns in trips.txt: "
            + ", ".join(mancanti)
        )

    colonne_trips = colonne_obbligatorie.copy()

    if "direction_id" in header_trips:
        colonne_trips.append("direction_id")

    trips = pd.read_csv(
        C.F_TRIPS,
        dtype=str,
        usecols=colonne_trips
    )

    for colonna in colonne_trips:
        trips[colonna] = (
            trips[colonna]
            .fillna("")
            .str.strip()
        )

    trips = trips[
        (trips["service_id"] != "")
        & (trips["trip_id"] != "")
        & (trips["shape_id"] != "")
    ].copy()

    # A trip_id must appear only once in trips.txt.
    # I also keep shape and service in the key to make
    # the check explicit.
    colonne_univoche = [
        "service_id",
        "trip_id",
        "shape_id",
    ]

    if "direction_id" in trips.columns:
        colonne_univoche.append("direction_id")

    trips = trips.drop_duplicates(
        subset=colonne_univoche,
        keep="first"
    ).copy()

    C.log(
        f"Valid trips with service_id and shape_id: {len(trips)}"
    )

    return trips


# ===========================================================================
# Reading and validating frequencies.txt
# ===========================================================================

def leggi_frequencies():
    """
    Reads and validates frequencies.txt.

    Returns:
    - a DataFrame with the valid time bands, if present;
    - None if the file does not exist, is empty, contains only the header
      or does not contain usable time bands.
    """

    if not os.path.isfile(C.F_FREQUENCIES):
        C.log(
            "frequencies.txt not present: "
            "I will use the trip-based method."
        )
        return None

    if os.path.getsize(C.F_FREQUENCIES) == 0:
        C.log(
            "frequencies.txt is completely empty: "
            "I will use the trip-based method."
        )
        return None

    C.log(f"Reading {C.F_FREQUENCIES}")

    try:
        freq = pd.read_csv(
            C.F_FREQUENCIES,
            dtype=str
        )
    except EmptyDataError:
        C.log(
            "frequencies.txt does not contain readable data: "
            "I will use the trip-based method."
        )
        return None

    if freq.empty:
        C.log(
            "frequencies.txt contains only the header: "
            "I will use the trip-based method."
        )
        return None

    colonne_obbligatorie = [
        "trip_id",
        "start_time",
        "end_time",
        "headway_secs",
    ]

    mancanti = [
        colonna
        for colonna in colonne_obbligatorie
        if colonna not in freq.columns
    ]

    if mancanti:
        C.log(
            "frequencies.txt is not usable. "
            "Missing columns: "
            + ", ".join(mancanti)
            + ". I will use the trip-based method."
        )
        return None

    # I keep only the necessary columns.
    freq = freq[colonne_obbligatorie].copy()

    freq["trip_id"] = (
        freq["trip_id"]
        .fillna("")
        .str.strip()
    )

    freq["start_time"] = (
        freq["start_time"]
        .fillna("")
        .str.strip()
    )

    freq["end_time"] = (
        freq["end_time"]
        .fillna("")
        .str.strip()
    )

    freq["start_sec"] = (
        freq["start_time"].apply(tempo_in_secondi)
    )

    freq["end_sec"] = (
        freq["end_time"].apply(tempo_in_secondi)
    )

    freq["headway_secs"] = pd.to_numeric(
        freq["headway_secs"],
        errors="coerce"
    )

    numero_righe_iniziale = len(freq)

    freq = freq.dropna(
        subset=[
            "start_sec",
            "end_sec",
            "headway_secs",
        ]
    ).copy()

    freq = freq[
        (freq["trip_id"] != "")
        & (freq["headway_secs"] > 0)
        & (freq["end_sec"] > freq["start_sec"])
    ].copy()

    numero_righe_scartate = (
        numero_righe_iniziale - len(freq)
    )

    C.log(
        f"Valid time bands in frequencies.txt: {len(freq)}"
    )

    C.log(
        f"Invalid time bands discarded: {numero_righe_scartate}"
    )

    if freq.empty:
        C.log(
            "frequencies.txt does not contain valid time bands: "
            "I will use the trip-based method."
        )
        return None

    freq["durata_fascia_sec"] = (
        freq["end_sec"] - freq["start_sec"]
    )

    # end_time is treated as the upper bound of the time band.
    #
    # Example:
    # 06:00:00 -> 06:59:59
    # headway = 1200 seconds
    #
    # ceil(3599 / 1200) = 3 trips
    freq["n_corse"] = (
        freq["durata_fascia_sec"]
        / freq["headway_secs"]
    ).apply(math.ceil).astype(int)

    C.log(
        "Trips per time band from frequencies.txt: "
        f"min={freq.n_corse.min():.0f}, "
        f"max={freq.n_corse.max():.0f}, "
        f"media={freq.n_corse.mean():.2f}"
    )

    return freq


# ===========================================================================
# Method A: frequencies.txt
# ===========================================================================

def calcola_da_frequencies(
    trips,
    freq,
    n_date_attive
):
    """
    Computes the passages using frequencies.txt.

    The equivalent patterns are deduplicated using:
    - route_id;
    - shape_id;
    - service_id;
    - direction_id, se presente;
    - start_time;
    - end_time;
    - headway_secs.
    """

    C.log(
        "Selected method: FREQUENCIES "
        "(frequencies.txt populated)."
    )

    trip_id_freq = set(freq["trip_id"])
    trip_id_trips = set(trips["trip_id"])

    numero_trip_con_frequenza = len(
        trip_id_trips.intersection(trip_id_freq)
    )

    numero_trip_senza_frequenza = len(
        trip_id_trips.difference(trip_id_freq)
    )

    frequenze_senza_trip = len(
        trip_id_freq.difference(trip_id_trips)
    )

    C.log(
        "Trips from trips.txt also present in frequencies.txt: "
        f"{numero_trip_con_frequenza}"
    )

    C.log(
        "Trips excluded because absent from frequencies.txt: "
        f"{numero_trip_senza_frequenza}"
    )

    C.log(
        "Trips from frequencies.txt not found in trips.txt: "
        f"{frequenze_senza_trip}"
    )

    # A row of frequencies.txt describes one time band of a trip.
    # A trip may have multiple time bands, so the relation can be one-to-many.
    trips_freq = trips.merge(
        freq,
        on="trip_id",
        how="inner",
        validate="one_to_many"
    )

    if trips_freq.empty:
        raise ValueError(
            "frequencies.txt contains valid rows, "
            "but no trip_id matches trips.txt."
        )

    C.log(
        f"Rows after join trips + frequencies: {len(trips_freq)}"
    )

    # -----------------------------------------------------------------------
    # Deduplication of the equivalent patterns
    # -----------------------------------------------------------------------

    colonne_pattern = [
        "route_id",
        "shape_id",
        "service_id",
        "start_time",
        "end_time",
        "headway_secs",
    ]

    if "direction_id" in trips_freq.columns:
        colonne_pattern.append("direction_id")

    numero_pattern_prima = len(trips_freq)

    trips_freq = trips_freq.drop_duplicates(
        subset=colonne_pattern,
        keep="first"
    ).copy()

    numero_pattern_eliminati = (
        numero_pattern_prima - len(trips_freq)
    )

    C.log(
        f"Equivalent patterns removed: "
        f"{numero_pattern_eliminati}"
    )

    C.log(
        f"Unique frequency patterns kept: "
        f"{len(trips_freq)}"
    )

    trips_freq["corse_giornaliere"] = (
        trips_freq["n_corse"].astype(int)
    )

    # -----------------------------------------------------------------------
    # Applying the calendar
    # -----------------------------------------------------------------------

    trips_freq["giorni_attivi"] = (
        trips_freq["service_id"]
        .map(n_date_attive)
        .fillna(0)
        .astype(int)
    )

    numero_pattern_senza_calendario = (
        trips_freq["giorni_attivi"] == 0
    ).sum()

    C.log(
        "Patterns with zero active dates after "
        "calendar/calendar_dates: "
        f"{numero_pattern_senza_calendario}"
    )

    # -----------------------------------------------------------------------
    # Passages in the period
    # -----------------------------------------------------------------------

    trips_freq["passaggi_periodo"] = (
        trips_freq["corse_giornaliere"]
        * trips_freq["giorni_attivi"]
    )

    C.log(
        "Passages in the period per pattern: "
        f"min={trips_freq.passaggi_periodo.min():.0f}, "
        f"max={trips_freq.passaggi_periodo.max():.0f}, "
        f"media={trips_freq.passaggi_periodo.mean():.2f}"
    )

    return trips_freq


# ===========================================================================
# Method B: trips.txt
# ===========================================================================

def calcola_da_trips(
    trips,
    n_date_attive
):
    """
    Computes the passages using the classic scheduled model.

    Each trip_id represents a trip and is counted once
    for each active date of its service_id.
    """

    C.log(
        "Selected method: TRIPS "
        "(frequencies.txt missing, empty or not usable)."
    )

    trips_scheduled = trips.copy()

    trips_scheduled["giorni_attivi"] = (
        trips_scheduled["service_id"]
        .map(n_date_attive)
        .fillna(0)
        .astype(int)
    )

    numero_trip_senza_calendario = (
        trips_scheduled["giorni_attivi"] == 0
    ).sum()

    C.log(
        "Trips with zero active dates after "
        "calendar/calendar_dates: "
        f"{numero_trip_senza_calendario}"
    )

    # Each row of trips.txt represents a scheduled trip.
    trips_scheduled["corse_giornaliere"] = 1

    trips_scheduled["passaggi_periodo"] = (
        trips_scheduled["corse_giornaliere"]
        * trips_scheduled["giorni_attivi"]
    )

    C.log(
        "Passages in the period per trip: "
        f"min={trips_scheduled.passaggi_periodo.min():.0f}, "
        f"max={trips_scheduled.passaggi_periodo.max():.0f}, "
        f"media={trips_scheduled.passaggi_periodo.mean():.2f}"
    )

    return trips_scheduled


# ===========================================================================
# Optional debug
# ===========================================================================

def stampa_debug_shape(
    dati_calcolo,
    shape_id,
    giorni_periodo,
    metodo
):
    """
    Prints a summary for a specific shape.

    To disable debugging, set DEBUG_SHAPE = None in main.
    """

    if not shape_id:
        return

    debug_shape = dati_calcolo[
        dati_calcolo["shape_id"] == shape_id
    ].copy()

    C.log(f"===== DEBUG SHAPE {shape_id} =====")

    if debug_shape.empty:
        C.log(
            f"The shape {shape_id} is not present in the processed data."
        )
        C.log(f"===== END DEBUG SHAPE {shape_id} =====")
        return

    if metodo == "frequencies":
        colonne_debug = [
            "trip_id",
            "route_id",
            "service_id",
            "start_time",
            "end_time",
            "headway_secs",
            "corse_giornaliere",
            "giorni_attivi",
            "passaggi_periodo",
        ]

        C.log(
            f"Number of associated patterns: {len(debug_shape)}"
        )

    else:
        colonne_debug = [
            "trip_id",
            "route_id",
            "service_id",
            "corse_giornaliere",
            "giorni_attivi",
            "passaggi_periodo",
        ]

        C.log(
            "Number of associated trips: "
            f"{debug_shape['trip_id'].nunique()}"
        )

    if "direction_id" in debug_shape.columns:
        posizione = colonne_debug.index("service_id") + 1
        colonne_debug.insert(
            posizione,
            "direction_id"
        )

    colonne_debug = [
        colonna
        for colonna in colonne_debug
        if colonna in debug_shape.columns
    ]

    ordinamento = [
        colonna
        for colonna in [
            "service_id",
            "start_sec",
            "trip_id",
        ]
        if colonna in debug_shape.columns
    ]

    if ordinamento:
        debug_shape = debug_shape.sort_values(ordinamento)

    print(
        debug_shape[colonne_debug]
        .to_string(index=False)
    )

    riepilogo_service = (
        debug_shape
        .groupby("service_id")
        .agg(
            elementi=("trip_id", "nunique"),
            corse_giornaliere=("corse_giornaliere", "sum"),
            passaggi_periodo=("passaggi_periodo", "sum"),
        )
    )

    print("\nSUMMARY BY SERVICE_ID")
    print(riepilogo_service.to_string())

    passaggi_totali = (
        debug_shape["passaggi_periodo"].sum()
    )

    frequenza_media = (
        passaggi_totali / giorni_periodo
    )

    print("\nSHAPE TOTALS")
    print(f"Passages in the period: {passaggi_totali}")
    print(
        "Average daily frequency: "
        f"{frequenza_media:.6f}"
    )

    C.log(f"===== END DEBUG SHAPE {shape_id} =====")


# ===========================================================================
# Main
# ===========================================================================

def main():

    # Set to None to disable debugging.
    DEBUG_SHAPE = None

    # To check line 203 again:
    # DEBUG_SHAPE = "203_A"

    # -----------------------------------------------------------------------
    # 1. Calendar and overall period
    # -----------------------------------------------------------------------

    C.log(
        "Computing active dates per service_id "
        "(calendar + calendar_dates)..."
    )

    date_attive, inizio_periodo, fine_periodo = (
        calcola_date_attive()
    )



    giorni_periodo = (
        fine_periodo - inizio_periodo
    ).days + 1

    if giorni_periodo <= 0:
        raise ValueError(
            f"Invalid period duration: {giorni_periodo}"
        )

    n_date_attive = {
        service_id: len(date)
        for service_id, date in date_attive.items()
    }

    C.log(
        f"GTFS period: {inizio_periodo} -> {fine_periodo}"
    )

    C.log(
        f"Total number of days in the period: "
        f"{giorni_periodo}"
    )

    C.log(
        f"Service_id found in the calendar: "
        f"{len(n_date_attive)}"
    )

    for service_id, numero_date in sorted(
        n_date_attive.items()
    ):
        C.log(
            f"Active dates service_id {service_id}: "
            f"{numero_date}"
        )

    # -----------------------------------------------------------------------
    # 2. Reading trips.txt
    # -----------------------------------------------------------------------

    trips = leggi_trips()

    # -----------------------------------------------------------------------
    # 3. Checking frequencies.txt
    # -----------------------------------------------------------------------

    freq = leggi_frequencies()

    # -----------------------------------------------------------------------
    # 4. Automatic method selection
    # -----------------------------------------------------------------------

    if freq is not None and not freq.empty:

        metodo = "frequencies"

        dati_calcolo = calcola_da_frequencies(
            trips=trips,
            freq=freq,
            n_date_attive=n_date_attive
        )

    else:

        metodo = "trips"

        dati_calcolo = calcola_da_trips(
            trips=trips,
            n_date_attive=n_date_attive
        )

    # -----------------------------------------------------------------------
    # 5. Optional debug
    # -----------------------------------------------------------------------

    stampa_debug_shape(
        dati_calcolo=dati_calcolo,
        shape_id=DEBUG_SHAPE,
        giorni_periodo=giorni_periodo,
        metodo=metodo
    )

    # -----------------------------------------------------------------------
    # 6. Aggregation per shape
    # -----------------------------------------------------------------------

    agg = (
        dati_calcolo
        .groupby(
            "shape_id",
            as_index=False
        )["passaggi_periodo"]
        .sum()
        .rename(
            columns={
                "passaggi_periodo": "passaggi_totali"
            }
        )
    )

    # Average over all days of the GTFS period.
    agg["freq_giornaliera"] = (
        agg["passaggi_totali"]
        / giorni_periodo
    )

    agg = agg.sort_values(
        "shape_id"
    ).reset_index(drop=True)

    # -----------------------------------------------------------------------
    # 7. Final checks
    # -----------------------------------------------------------------------

    C.log(
        f"Method used: {metodo.upper()}"
    )

    C.log(
        f"Resulting shapes: {len(agg)}"
    )

    C.log(
        "Total passages per shape: "
        f"min={agg.passaggi_totali.min():.0f}, "
        f"max={agg.passaggi_totali.max():.0f}"
    )

    C.log(
        "Average daily frequency per shape: "
        f"min={agg.freq_giornaliera.min():.3f}, "
        f"max={agg.freq_giornaliera.max():.3f}, "
        f"media={agg.freq_giornaliera.mean():.3f}"
    )

    # -----------------------------------------------------------------------
    # 8. Saving CSV
    # -----------------------------------------------------------------------

    agg.to_csv(
        C.CSV_FREQ_SHAPE,
        index=False
    )

    C.log(f"Saved -> {C.CSV_FREQ_SHAPE}")


if __name__ == "__main__":
    main()