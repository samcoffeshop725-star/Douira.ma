-- Verrou de lecture directe sur quatre tables qui l'avaient perdu.
--
-- Le modèle de Douira : l'API est la SEULE porte. Les tables activent donc la
-- sécurité au niveau des lignes sans aucune politique, ce qui ferme tout accès
-- direct ; l'API, elle, se connecte avec le rôle propriétaire et n'est pas
-- concernée. C'est la ligne « ALTER TABLE … ENABLE ROW LEVEL SECURITY » qui
-- termine chaque migration depuis le début.
--
-- Quatre tables ajoutées en cours de route l'ont oubliée :
--
--   invoices           montants facturés et instantané de la facture
--   card_offers        tarifs des cartes de membre
--   scans              journal des lectures de carte (qui, quand, où)
--   service_categories catégories de services
--
-- Chez Supabase, une table sans ce verrou est lisible par le rôle « anon » à
-- travers l'API REST du projet : n'importe qui connaissant l'URL publique et
-- la clé anonyme pouvait lire les factures et le journal des scans. Les deux
-- premières contiennent des données commerciales, la troisième dit où et quand
-- une personne s'est présentée.
--
-- Rien n'est supprimé, aucune donnée n'est touchée, et l'API continue de lire
-- et d'écrire exactement comme avant : seul l'accès DIRECT est refermé.

ALTER TABLE invoices           ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_offers        ENABLE ROW LEVEL SECURITY;
ALTER TABLE scans              ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_categories ENABLE ROW LEVEL SECURITY;
