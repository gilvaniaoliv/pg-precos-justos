-- ============================================================================
-- P&G PREÇOS JUSTOS - SCRIPT DE BANCO DE DADOS E SEGURANÇA (SUPABASE)
-- Fase 1 + Atualização de Categorias e Subcategorias (Cômodos, Masculino/Feminino)
-- ============================================================================

-- Extensão para geração de UUIDs
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 1. TABELA DE CATEGORIAS (COM SUBCATEGORIAS INTERNAS)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.categorias (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome TEXT NOT NULL CHECK (char_length(trim(nome)) > 0 AND char_length(nome) <= 80),
    slug TEXT NOT NULL UNIQUE,
    subcategorias TEXT[] NOT NULL DEFAULT '{}',
    ordem INTEGER NOT NULL DEFAULT 0,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Caso a tabela já tenha sido criada antes, adiciona a coluna subcategorias sem perder dados
ALTER TABLE public.categorias ADD COLUMN IF NOT EXISTS subcategorias TEXT[] NOT NULL DEFAULT '{}';

-- ============================================================================
-- 2. TABELA DE PRODUTOS (CONTÉM CAMPOS PÚBLICOS E CAMPOS RESTRITOS DO ADMIN)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.produtos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome TEXT NOT NULL CHECK (char_length(trim(nome)) > 0 AND char_length(nome) <= 160),
    descricao TEXT DEFAULT '',
    categoria_id UUID REFERENCES public.categorias(id) ON DELETE SET NULL,
    subcategoria TEXT DEFAULT '',
    foto_url TEXT DEFAULT '',

    -- Preços e pesquisa de mercado (públicos na vitrine conforme regras)
    preco_venda NUMERIC(10, 2) NOT NULL CHECK (preco_venda >= 0),
    preco_medio_mercado NUMERIC(10, 2) CHECK (preco_medio_mercado IS NULL OR preco_medio_mercado >= 0),
    data_pesquisa DATE,

    -- Campos EXCLUSIVOS DO ADMIN (NUNCA expostos na view pública)
    fontes_pesquisa TEXT DEFAULT '',
    preco_minimo_negociacao NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (preco_minimo_negociacao >= 0),
    preco_custo NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (preco_custo >= 0),

    -- Controle de estoque e exibição
    estoque INTEGER NOT NULL DEFAULT 0 CHECK (estoque >= 0),
    destaque BOOLEAN NOT NULL DEFAULT false,
    ativo BOOLEAN NOT NULL DEFAULT true,

    criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Caso a tabela já tenha sido criada antes, adiciona a coluna subcategoria
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS subcategoria TEXT DEFAULT '';

-- Índices para deixar filtros e buscas rápidos
CREATE INDEX IF NOT EXISTS idx_produtos_ativo ON public.produtos(ativo);
CREATE INDEX IF NOT EXISTS idx_produtos_categoria ON public.produtos(categoria_id);
CREATE INDEX IF NOT EXISTS idx_produtos_subcategoria ON public.produtos(subcategoria);
CREATE INDEX IF NOT EXISTS idx_produtos_destaque ON public.produtos(destaque) WHERE ativo = true;

-- Trigger para atualizar automaticamente o campo atualizado_em
CREATE OR REPLACE FUNCTION public.atualizar_timestamp_produto()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.atualizado_em = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_produtos_atualizado_em ON public.produtos;
CREATE TRIGGER trg_produtos_atualizado_em
BEFORE UPDATE ON public.produtos
FOR EACH ROW
EXECUTE FUNCTION public.atualizar_timestamp_produto();

-- ============================================================================
-- 3. TABELA DE VENDAS (EXCLUSIVA DO ADMIN)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.vendas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    produto_id UUID REFERENCES public.produtos(id) ON DELETE SET NULL,
    nome_produto_snapshot TEXT NOT NULL,
    quantidade INTEGER NOT NULL CHECK (quantidade > 0),
    valor_unitario NUMERIC(10, 2) NOT NULL CHECK (valor_unitario >= 0),
    valor_total NUMERIC(10, 2) NOT NULL CHECK (valor_total >= 0),
    custo_unitario_snapshot NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (custo_unitario_snapshot >= 0),
    abaixo_preco_minimo BOOLEAN NOT NULL DEFAULT false,
    observacao TEXT DEFAULT '',
    data_venda TIMESTAMPTZ NOT NULL DEFAULT now(),
    registrado_por UUID DEFAULT auth.uid()
);

CREATE INDEX IF NOT EXISTS idx_vendas_data_venda ON public.vendas(data_venda DESC);

-- ============================================================================
-- 4. ROW LEVEL SECURITY (RLS) E BLOQUEIO DE COLUNAS SENSÍVEIS
-- ============================================================================
ALTER TABLE public.categorias ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.produtos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendas ENABLE ROW LEVEL SECURITY;

-- Força o RLS até para o dono da tabela (segurança extra)
ALTER TABLE public.categorias FORCE ROW LEVEL SECURITY;
ALTER TABLE public.produtos FORCE ROW LEVEL SECURITY;
ALTER TABLE public.vendas FORCE ROW LEVEL SECURITY;

-- Limpa políticas antigas caso o script seja rodado mais de uma vez
DROP POLICY IF EXISTS "Categorias visiveis para todos" ON public.categorias;
DROP POLICY IF EXISTS "Admin gerencia categorias" ON public.categorias;
DROP POLICY IF EXISTS "Admin gerencia produtos" ON public.produtos;
DROP POLICY IF EXISTS "Admin gerencia vendas" ON public.vendas;

-- 4.1 Políticas para CATEGORIAS:
-- Visitantes (anon) e admins (authenticated) podem ler categorias
CREATE POLICY "Categorias visiveis para todos"
    ON public.categorias
    FOR SELECT
    TO anon, authenticated
    USING (true);

-- Apenas usuários autenticados (você e seu sócio) podem criar, editar ou apagar categorias
CREATE POLICY "Admin gerencia categorias"
    ON public.categorias
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

-- 4.2 Políticas para PRODUTOS (TABELA COMPLETA):
-- ATENÇÃO: Anônimos NÃO têm política na tabela 'produtos' e têm o privilégio SELECT revogado!
-- Isso garante que preco_custo, preco_minimo_negociacao e fontes_pesquisa NUNCA vazem.
REVOKE ALL ON TABLE public.produtos FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.produtos TO authenticated;

CREATE POLICY "Admin gerencia produtos"
    ON public.produtos
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

-- 4.3 Políticas para VENDAS:
-- Anônimos não têm nenhum acesso à tabela de vendas.
REVOKE ALL ON TABLE public.vendas FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vendas TO authenticated;

CREATE POLICY "Admin gerencia vendas"
    ON public.vendas
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

-- Permissões da tabela de categorias
REVOKE ALL ON TABLE public.categorias FROM anon;
GRANT SELECT ON TABLE public.categorias TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.categorias TO authenticated;

-- ============================================================================
-- 5. VIEW PÚBLICA DE PRODUTOS (ACESSÍVEL POR VISITANTES ANÔNIMOS)
-- ============================================================================
DROP VIEW IF EXISTS public.produtos_publicos;

CREATE VIEW public.produtos_publicos AS
SELECT
    p.id,
    p.nome,
    p.descricao,
    p.categoria_id,
    c.nome AS categoria_nome,
    c.slug AS categoria_slug,
    p.subcategoria,
    p.foto_url,
    p.preco_venda,
    p.preco_medio_mercado,
    p.data_pesquisa,
    p.estoque,
    p.destaque,
    p.criado_em
FROM public.produtos p
LEFT JOIN public.categorias c ON c.id = p.categoria_id
WHERE p.ativo = true;

-- Concede APENAS leitura (SELECT) na view pública para visitantes e autenticados
REVOKE ALL ON TABLE public.produtos_publicos FROM anon, authenticated;
GRANT SELECT ON TABLE public.produtos_publicos TO anon, authenticated;

-- ============================================================================
-- 6. FUNÇÃO TRANSACIONAL PARA REGISTRAR VENDA E BAIXAR ESTOQUE (SÓ ADMIN)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.registrar_venda_admin(
    p_produto_id UUID,
    p_quantidade INTEGER,
    p_valor_total NUMERIC,
    p_observacao TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_produto public.produtos%ROWTYPE;
    v_valor_unitario NUMERIC(10, 2);
    v_abaixo_minimo BOOLEAN;
    v_venda_id UUID;
BEGIN
    -- Garante que apenas usuários logados possam executar
    IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Acesso negado: apenas administradores autenticados podem registrar vendas.';
    END IF;

    IF p_quantidade IS NULL OR p_quantidade <= 0 THEN
        RAISE EXCEPTION 'A quantidade vendida deve ser maior que zero.';
    END IF;

    IF p_valor_total IS NULL OR p_valor_total < 0 THEN
        RAISE EXCEPTION 'O valor total da venda não pode ser negativo.';
    END IF;

    -- Bloqueia a linha do produto durante a transação para evitar estoque incorreto
    SELECT * INTO v_produto
    FROM public.produtos
    WHERE id = p_produto_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Produto não encontrado.';
    END IF;

    IF v_produto.estoque < p_quantidade THEN
        RAISE EXCEPTION 'Estoque insuficiente. Disponível: % unidade(s).', v_produto.estoque;
    END IF;

    v_valor_unitario := ROUND(p_valor_total / p_quantidade, 2);
    v_abaixo_minimo := (v_valor_unitario < v_produto.preco_minimo_negociacao);

    -- 1. Desconta do estoque
    UPDATE public.produtos
    SET estoque = estoque - p_quantidade,
        atualizado_em = now()
    WHERE id = p_produto_id;

    -- 2. Registra a venda com snapshot do nome e custo do momento
    INSERT INTO public.vendas (
        produto_id,
        nome_produto_snapshot,
        quantidade,
        valor_unitario,
        valor_total,
        custo_unitario_snapshot,
        abaixo_preco_minimo,
        observacao,
        registrado_por
    ) VALUES (
        v_produto.id,
        v_produto.nome,
        p_quantidade,
        v_valor_unitario,
        p_valor_total,
        v_produto.preco_custo,
        v_abaixo_minimo,
        COALESCE(p_observacao, ''),
        auth.uid()
    )
    RETURNING id INTO v_venda_id;

    RETURN jsonb_build_object(
        'sucesso', true,
        'venda_id', v_venda_id,
        'novo_estoque', v_produto.estoque - p_quantidade,
        'abaixo_preco_minimo', v_abaixo_minimo
    );
END;
$$;

REVOKE ALL ON FUNCTION public.registrar_venda_admin(UUID, INTEGER, NUMERIC, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_venda_admin(UUID, INTEGER, NUMERIC, TEXT) TO authenticated;

-- ============================================================================
-- 7. STORAGE PARA FOTOS DOS PRODUTOS (BUCKET: produtos-fotos)
-- ============================================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'produtos-fotos',
    'produtos-fotos',
    true,
    5242880, -- Limite de 5 MB por foto
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Políticas de Storage em storage.objects
DROP POLICY IF EXISTS "Fotos publicas para leitura" ON storage.objects;
DROP POLICY IF EXISTS "Admin faz upload de fotos" ON storage.objects;
DROP POLICY IF EXISTS "Admin atualiza fotos" ON storage.objects;
DROP POLICY IF EXISTS "Admin exclui fotos" ON storage.objects;

CREATE POLICY "Fotos publicas para leitura"
    ON storage.objects
    FOR SELECT
    TO anon, authenticated
    USING (bucket_id = 'produtos-fotos');

CREATE POLICY "Admin faz upload de fotos"
    ON storage.objects
    FOR INSERT
    TO authenticated
    WITH CHECK (bucket_id = 'produtos-fotos');

CREATE POLICY "Admin atualiza fotos"
    ON storage.objects
    FOR UPDATE
    TO authenticated
    USING (bucket_id = 'produtos-fotos')
    WITH CHECK (bucket_id = 'produtos-fotos');

CREATE POLICY "Admin exclui fotos"
    ON storage.objects
    FOR DELETE
    TO authenticated
    USING (bucket_id = 'produtos-fotos');

-- ============================================================================
-- 8. CATEGORIAS E SUBCATEGORIAS ORGANIZADAS (CÔMODOS, MASCULINO/FEMININO, ETC.)
-- ============================================================================
-- Remove categorias antigas sem produtos vinculados para deixar a nova estrutura limpa
DELETE FROM public.categorias
WHERE slug IN ('casa-e-cozinha', 'eletronicos-e-acessorios', 'utilidades-e-ferramentas', 'ofertas-da-semana')
  AND id NOT IN (SELECT DISTINCT categoria_id FROM public.produtos WHERE categoria_id IS NOT NULL);

INSERT INTO public.categorias (nome, slug, subcategorias, ordem)
VALUES
    (
        'Casa e Cômodos',
        'casa-e-comodos',
        ARRAY['Cozinha', 'Sala', 'Quarto', 'Banheiro', 'Lavanderia e Limpeza', 'Jardim e Varanda'],
        1
    ),
    (
        'Cuidados Pessoais e Beleza',
        'cuidados-pessoais',
        ARRAY['Feminino', 'Masculino', 'Unissex', 'Infantil', 'Perfumaria', 'Cabelo e Barba'],
        2
    ),
    (
        'Moda, Bolsas e Acessórios',
        'moda-e-acessorios',
        ARRAY['Feminino', 'Masculino', 'Unissex', 'Infantil', 'Relógios e Óculos', 'Bolsas e Carteiras'],
        3
    ),
    (
        'Eletrônicos e Tecnologia',
        'eletronicos-e-tecnologia',
        ARRAY['Áudio e Fones', 'Celular e Carregadores', 'Informática', 'Smartwatch', 'Caixas de Som'],
        4
    ),
    (
        'Ferramentas e Utilidades',
        'ferramentas-e-utilidades',
        ARRAY['Ferramentas Manuais', 'Elétrica e Iluminação', 'Automotivo', 'Organização'],
        5
    ),
    (
        'Infantil e Brinquedos',
        'infantil-e-brinquedos',
        ARRAY['Meninos', 'Meninas', 'Bebês', 'Jogos e Educativos'],
        6
    ),
    (
        'Kits e Promoções',
        'kits-e-promocoes',
        ARRAY['Kits Presente Masculino', 'Kits Presente Feminino', 'Kits para Casa', 'Queima de Estoque'],
        7
    )
ON CONFLICT (slug) DO UPDATE SET
    nome = EXCLUDED.nome,
    subcategorias = EXCLUDED.subcategorias,
    ordem = EXCLUDED.ordem;
