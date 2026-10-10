CREATE TABLE IF NOT EXISTS employees (
  user_id TEXT PRIMARY KEY
    CHECK (length(user_id) = 6 AND user_id NOT GLOB '*[^0-9]*'),
  full_name TEXT NOT NULL,
  shift_start TEXT NOT NULL CHECK (time(shift_start) IS NOT NULL),
  shift_end TEXT NOT NULL CHECK (time(shift_end) IS NOT NULL),
  days_of_week TEXT NOT NULL CHECK (
    days_of_week IN (
      'Mon-Fri',
      'Mon-Thu',
      'Tue-Sat',
      'Wed-Sun',
      'Tue-Fri',
      'Sun-Thu'
    )
  ),
  CHECK (time(shift_end) > time(shift_start))
);

INSERT INTO employees (user_id, full_name, shift_start, shift_end, days_of_week)
VALUES
  ('482917', 'Naomi Brooks', '06:00', '14:30', 'Mon-Fri'),
  ('305764', 'Dmitri Volkov', '06:30', '15:00', 'Mon-Fri'),
  ('718203', 'Ayesha Khan', '07:00', '15:30', 'Mon-Thu'),
  ('926541', 'Walter Jennings', '07:00', '15:30', 'Mon-Fri'),
  ('134098', 'Camila Torres', '07:00', '15:30', 'Mon-Fri'),
  ('657320', 'Isaiah Brown', '07:30', '16:00', 'Tue-Sat'),
  ('291846', 'Mei-Ling Chen', '07:30', '16:00', 'Mon-Fri'),
  ('840573', 'Patrick O’Connell', '07:30', '16:00', 'Mon-Thu'),
  ('513689', 'Fatima Hassan', '08:00', '16:30', 'Mon-Fri'),
  ('762405', 'Gabriel Santos', '08:00', '16:30', 'Wed-Sun'),
  ('378152', 'Rebecca Lindqvist', '08:00', '16:30', 'Mon-Fri'),
  ('094637', 'Terrence Hall', '08:00', '16:30', 'Mon-Fri'),
  ('625981', 'Anika Sharma', '08:00', '16:30', 'Tue-Fri'),
  ('417306', 'Luis Herrera', '08:00', '16:30', 'Mon-Thu'),
  ('859264', 'Chloe Dubois', '08:30', '17:00', 'Mon-Fri'),
  ('230715', 'Omar Farouk', '08:30', '17:00', 'Tue-Sat'),
  ('986423', 'Josephine Wright', '08:30', '17:00', 'Mon-Fri'),
  ('541078', 'Kenji Tanaka', '08:30', '17:00', 'Mon-Fri'),
  ('173859', 'Savannah Reed', '08:30', '17:00', 'Mon-Thu'),
  ('704392', 'Andre Baptiste', '09:00', '17:30', 'Mon-Fri'),
  ('368217', 'Ingrid Larsen', '09:00', '17:30', 'Sun-Thu'),
  ('892645', 'Hector Ramirez', '09:00', '17:30', 'Mon-Fri'),
  ('456031', 'Tamara Goldberg', '09:00', '17:30', 'Mon-Fri'),
  ('217984', 'Nathan Whitehorse', '09:00', '17:30', 'Tue-Sat'),
  ('639570', 'Yasmin Aziz', '09:30', '18:00', 'Mon-Fri'),
  ('081426', 'Caleb Morrison', '09:30', '18:00', 'Mon-Thu'),
  ('774163', 'Bao Tran', '10:00', '18:30', 'Mon-Fri'),
  ('325908', 'Delia Kowalski', '10:00', '18:30', 'Wed-Sun'),
  ('910352', 'Jamal Peterson', '14:00', '22:30', 'Sun-Thu'),
  ('563741', 'Olivia Fontaine', '14:00', '22:30', 'Tue-Sat')
ON CONFLICT(user_id) DO UPDATE SET
  full_name = excluded.full_name,
  shift_start = excluded.shift_start,
  shift_end = excluded.shift_end,
  days_of_week = excluded.days_of_week;
