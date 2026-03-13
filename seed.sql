-- ============================================================
-- EJ Newsfeed — Seed Data
-- Run AFTER schema.sql. Populates categories and sample sources.
-- ============================================================

INSERT INTO categories (name, description, color) VALUES
  ('AI',               'Artificial intelligence, machine learning, LLMs, and AI policy',          '#EC4899'),
  ('IT',               'Software engineering, infrastructure, hardware, and developer tools',     '#3B82F6'),
  ('Entrepreneurship', 'Startups, venture capital, founder stories, and growth strategies',       '#10B981'),
  ('UX Design',        'Design systems, user experience, product thinking, and design tools',     '#8B5CF6'),
  ('Business',         'Strategy, markets, corporate news, and macroeconomic trends',             '#F59E0B');

-- Sample sources (add your newsletters here as you subscribe them)
INSERT INTO sources (name, email_address, website_url) VALUES
  ('Morning Brew',       'crew@morningbrew.com',      'https://morningbrew.com'),
  ('The Hustle',         'team@thehustle.co',          'https://thehustle.co'),
  ('TLDR Newsletter',    'dan@tldrnewsletter.com',     'https://tldr.tech'),
  ('UX Collective',      'hello@uxdesign.cc',          'https://uxdesign.cc'),
  ('Benedict Evans',     'ben@ben-evans.com',          'https://ben-evans.com'),
  ('Stratechery',        'ben@stratechery.com',        'https://stratechery.com'),
  ('MIT Tech Review',    'newsletters@technologyreview.com', 'https://technologyreview.com'),
  ('Product Hunt Daily', 'noreply@producthunt.com',   'https://producthunt.com');
