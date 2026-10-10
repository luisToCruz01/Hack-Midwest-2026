PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS locations (
  location_id INTEGER PRIMARY KEY CHECK (location_id BETWEEN 1 AND 200),
  name TEXT NOT NULL UNIQUE
);

WITH RECURSIVE location_numbers(location_id) AS (
  SELECT 1
  UNION ALL
  SELECT location_id + 1
  FROM location_numbers
  WHERE location_id < 200
)
INSERT INTO locations (location_id, name)
SELECT location_id, printf('Location %03d', location_id)
FROM location_numbers
WHERE 1
ON CONFLICT(location_id) DO UPDATE SET name = excluded.name;

CREATE TABLE IF NOT EXISTS employees (
  user_id TEXT PRIMARY KEY
    CHECK (length(user_id) = 6 AND user_id NOT GLOB '*[^0-9]*'),
  location_id INTEGER NOT NULL REFERENCES locations(location_id),
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

INSERT INTO employees (user_id, location_id, full_name, shift_start, shift_end, days_of_week)
VALUES
  ('482917', 1, 'Naomi Brooks', '06:00', '14:30', 'Mon-Fri'),
  ('305764', 1, 'Dmitri Volkov', '06:30', '15:00', 'Mon-Fri'),
  ('718203', 1, 'Ayesha Khan', '07:00', '15:30', 'Mon-Thu'),
  ('926541', 1, 'Walter Jennings', '07:00', '15:30', 'Mon-Fri'),
  ('134098', 1, 'Camila Torres', '07:00', '15:30', 'Mon-Fri'),
  ('657320', 1, 'Isaiah Brown', '07:30', '16:00', 'Tue-Sat'),
  ('291846', 1, 'Mei-Ling Chen', '07:30', '16:00', 'Mon-Fri'),
  ('840573', 1, 'Patrick O’Connell', '07:30', '16:00', 'Mon-Thu'),
  ('513689', 1, 'Fatima Hassan', '08:00', '16:30', 'Mon-Fri'),
  ('762405', 1, 'Gabriel Santos', '08:00', '16:30', 'Wed-Sun'),
  ('378152', 1, 'Rebecca Lindqvist', '08:00', '16:30', 'Mon-Fri'),
  ('094637', 1, 'Terrence Hall', '08:00', '16:30', 'Mon-Fri'),
  ('625981', 1, 'Anika Sharma', '08:00', '16:30', 'Tue-Fri'),
  ('417306', 1, 'Luis Herrera', '08:00', '16:30', 'Mon-Thu'),
  ('859264', 1, 'Chloe Dubois', '08:30', '17:00', 'Mon-Fri'),
  ('230715', 1, 'Omar Farouk', '08:30', '17:00', 'Tue-Sat'),
  ('986423', 1, 'Josephine Wright', '08:30', '17:00', 'Mon-Fri'),
  ('541078', 1, 'Kenji Tanaka', '08:30', '17:00', 'Mon-Fri'),
  ('173859', 1, 'Savannah Reed', '08:30', '17:00', 'Mon-Thu'),
  ('704392', 1, 'Andre Baptiste', '09:00', '17:30', 'Mon-Fri'),
  ('368217', 1, 'Ingrid Larsen', '09:00', '17:30', 'Sun-Thu'),
  ('892645', 1, 'Hector Ramirez', '09:00', '17:30', 'Mon-Fri'),
  ('456031', 1, 'Tamara Goldberg', '09:00', '17:30', 'Mon-Fri'),
  ('217984', 1, 'Nathan Whitehorse', '09:00', '17:30', 'Tue-Sat'),
  ('639570', 1, 'Yasmin Aziz', '09:30', '18:00', 'Mon-Fri'),
  ('081426', 1, 'Caleb Morrison', '09:30', '18:00', 'Mon-Thu'),
  ('774163', 1, 'Bao Tran', '10:00', '18:30', 'Mon-Fri'),
  ('325908', 1, 'Delia Kowalski', '10:00', '18:30', 'Wed-Sun'),
  ('910352', 1, 'Jamal Peterson', '14:00', '22:30', 'Sun-Thu'),
  ('563741', 1, 'Olivia Fontaine', '14:00', '22:30', 'Tue-Sat')
ON CONFLICT(user_id) DO UPDATE SET
  location_id = excluded.location_id,
  full_name = excluded.full_name,
  shift_start = excluded.shift_start,
  shift_end = excluded.shift_end,
  days_of_week = excluded.days_of_week;

WITH
first_names(name) AS (
  VALUES
    ('Aaliyah'), ('Aaron'), ('Abigail'), ('Adam'), ('Adrian'), ('Aiden'),
    ('Alex'), ('Alexa'), ('Alice'), ('Amara'), ('Amir'), ('Amy'),
    ('Andrea'), ('Andrew'), ('Angela'), ('Anthony'), ('Aria'), ('Ari'),
    ('Arthur'), ('Ava'), ('Avery'), ('Bella'), ('Benjamin'), ('Blake'),
    ('Brandon'), ('Brenda'), ('Brian'), ('Brooke'), ('Caleb'), ('Cameron'),
    ('Carla'), ('Carlos'), ('Carmen'), ('Caroline'), ('Carter'), ('Cassandra'),
    ('Catherine'), ('Cecilia'), ('Charles'), ('Charlotte'), ('Chase'), ('Christian'),
    ('Christina'), ('Christopher'), ('Clara'), ('Cole'), ('Connor'), ('Daisy'),
    ('Daniel'), ('Dante'), ('David'), ('Diana'), ('Dominic'), ('Dylan'),
    ('Elena'), ('Eli'), ('Elijah'), ('Elizabeth'), ('Ella'), ('Elliot'),
    ('Emily'), ('Emma'), ('Ethan'), ('Eva'), ('Evelyn'), ('Felix'),
    ('Gabriela'), ('Gabriel'), ('Gemma'), ('George'), ('Grace'), ('Hannah'),
    ('Harper'), ('Henry'), ('Ibrahim'), ('Iris'), ('Isaac'), ('Isabel'),
    ('Jack'), ('Jackson'), ('Jacob'), ('Jade'), ('James'), ('Jasmine'),
    ('Jason'), ('Javier'), ('Jenna'), ('Jeremy'), ('Jesse'), ('Jocelyn'),
    ('Joel'), ('Jordan'), ('Julia'), ('Julian'), ('June'), ('Kai'),
    ('Kara'), ('Karina'), ('Keith'), ('Kelsey'), ('Kevin'), ('Kimberly'),
    ('Lana'), ('Laura'), ('Leah'), ('Leo'), ('Liam'), ('Lila'),
    ('Lily'), ('Logan'), ('Lucas'), ('Lucy'), ('Madeline'), ('Marcus'),
    ('Maria'), ('Marina'), ('Mason'), ('Mateo'), ('Maya'), ('Megan'),
    ('Melanie'), ('Micah'), ('Michael'), ('Mila'), ('Miles'), ('Mina'),
    ('Morgan'), ('Nadia'), ('Natalie'), ('Nicolas'), ('Noah'), ('Nora'),
    ('Oliver'), ('Oscar'), ('Owen'), ('Paige'), ('Parker'), ('Paul'),
    ('Penelope'), ('Peter'), ('Quinn'), ('Rachel'), ('Rafael'), ('Rebecca'),
    ('Riley'), ('Rosa'), ('Ruby'), ('Ryan'), ('Sabrina'), ('Samuel'),
    ('Sara'), ('Sebastian'), ('Serena'), ('Sofia'), ('Sophia'), ('Stella'),
    ('Talia'), ('Taylor'), ('Theo'), ('Thomas'), ('Valentina'), ('Victor'),
    ('Violet'), ('Wesley'), ('Xavier'), ('Yara'), ('Zoe')
),
last_names(name) AS (
  VALUES
    ('Abbott'), ('Acosta'), ('Adams'), ('Ahmed'), ('Alvarez'), ('Anderson'),
    ('Armstrong'), ('Baker'), ('Baldwin'), ('Banks'), ('Barnes'), ('Bennett'),
    ('Bishop'), ('Black'), ('Blair'), ('Boyd'), ('Bradley'), ('Brooks'),
    ('Bryant'), ('Burke'), ('Burns'), ('Butler'), ('Campbell'), ('Carter'),
    ('Castillo'), ('Chavez'), ('Clark'), ('Cole'), ('Collins'), ('Cook'),
    ('Cooper'), ('Cox'), ('Cruz'), ('Davis'), ('Diaz'), ('Dixon'),
    ('Edwards'), ('Ellis'), ('Evans'), ('Fisher'), ('Flores'), ('Ford'),
    ('Foster'), ('Fox'), ('Garcia'), ('Gardner'), ('Gibson'), ('Gomez'),
    ('Gonzalez'), ('Gordon'), ('Graham'), ('Grant'), ('Gray'), ('Green'),
    ('Griffin'), ('Hall'), ('Hamilton'), ('Harris'), ('Hayes'), ('Henderson'),
    ('Hernandez'), ('Hill'), ('Howard'), ('Hudson'), ('Hughes'), ('Jackson'),
    ('James'), ('Jenkins'), ('Johnson'), ('Jones'), ('Kelly'), ('Kim'),
    ('King'), ('Knight'), ('Lee'), ('Lewis'), ('Long'), ('Lopez'),
    ('Marshall'), ('Martin'), ('Mason'), ('Miller'), ('Mitchell'), ('Moore'),
    ('Morgan'), ('Morris'), ('Murphy'), ('Nelson'), ('Nguyen'), ('Ortiz'),
    ('Parker'), ('Patterson'), ('Perez'), ('Perry'), ('Peterson'), ('Phillips'),
    ('Powell'), ('Price'), ('Reed'), ('Reyes'), ('Richardson'), ('Rivera'),
    ('Roberts'), ('Robinson'), ('Rodriguez'), ('Rogers'), ('Ross'), ('Russell'),
    ('Sanchez'), ('Sanders'), ('Scott'), ('Simmons'), ('Smith'), ('Stewart'),
    ('Taylor'), ('Thomas'), ('Thompson'), ('Torres'), ('Turner'), ('Walker'),
    ('Ward'), ('Watson'), ('White'), ('Williams'), ('Wilson'), ('Wood'),
    ('Wright'), ('Young'), ('Zamora')
),
existing_names(name) AS (
  VALUES
    ('Naomi Brooks'), ('Dmitri Volkov'), ('Ayesha Khan'),
    ('Walter Jennings'), ('Camila Torres'), ('Isaiah Brown'),
    ('Mei-Ling Chen'), ('Patrick O’Connell'), ('Fatima Hassan'),
    ('Gabriel Santos'), ('Rebecca Lindqvist'), ('Terrence Hall'),
    ('Anika Sharma'), ('Luis Herrera'), ('Chloe Dubois'),
    ('Omar Farouk'), ('Josephine Wright'), ('Kenji Tanaka'),
    ('Savannah Reed'), ('Andre Baptiste'), ('Ingrid Larsen'),
    ('Hector Ramirez'), ('Tamara Goldberg'), ('Nathan Whitehorse'),
    ('Yasmin Aziz'), ('Caleb Morrison'), ('Bao Tran'),
    ('Delia Kowalski'), ('Jamal Peterson'), ('Olivia Fontaine')
),
eligible_names(full_name) AS (
  SELECT first_names.name || ' ' || last_names.name
  FROM first_names
  CROSS JOIN last_names
  WHERE NOT EXISTS (
    SELECT 1 FROM existing_names
    WHERE existing_names.name = first_names.name || ' ' || last_names.name
  )
),
numbered_names AS (
  SELECT
    full_name,
    ROW_NUMBER() OVER (ORDER BY full_name) AS person_number
  FROM eligible_names
),
shifts(shift_number, start_time) AS (
  VALUES
    (0, '06:00'), (1, '06:30'), (2, '07:00'), (3, '07:30'),
    (4, '08:00'), (5, '08:30'), (6, '09:00'), (7, '09:30'),
    (8, '10:00'), (9, '10:30'), (10, '11:00'), (11, '11:30'),
    (12, '12:00'), (13, '12:30'), (14, '13:00'), (15, '13:30'),
    (16, '14:00')
),
workdays(day_number, days) AS (
  VALUES
    (0, 'Mon-Fri'), (1, 'Mon-Thu'), (2, 'Tue-Sat'),
    (3, 'Wed-Sun'), (4, 'Tue-Fri'), (5, 'Sun-Thu')
)
INSERT INTO employees (
  user_id, location_id, full_name, shift_start, shift_end, days_of_week
)
SELECT
  printf('%06d', 99999 + person_number),
  2 + ((person_number - 1) / 30),
  full_name,
  strftime('%H:%M', shifts.start_time),
  strftime('%H:%M', shifts.start_time, '+8 hours', '+30 minutes'),
  workdays.days
FROM numbered_names
JOIN shifts ON shifts.shift_number = person_number % 17
JOIN workdays ON workdays.day_number = person_number % 6
WHERE person_number <= 5970
ON CONFLICT(user_id) DO UPDATE SET
  location_id = excluded.location_id,
  full_name = excluded.full_name,
  shift_start = excluded.shift_start,
  shift_end = excluded.shift_end,
  days_of_week = excluded.days_of_week;
