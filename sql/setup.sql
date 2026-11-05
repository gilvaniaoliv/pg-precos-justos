-- ============================================================================
-- P&G PREÇOS JUSTOS - SCRIPT DE BANCO DE DADOS E SEGURANÇA (SUPABASE)
-- Fase 1 + Atualização Completa (Múltiplas Fotos, +18, Avaliações, Pedidos,
-- Endereço Estruturado, Categorias/Subcategorias, Taxas/Fretes e Mercado Pago)
-- ============================================================================

-- Extensão para geração de UUIDs e criptografia
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

-- Caso a tabela já tenha sido criada antes, adiciona as colunas sem perder dados
ALTER TABLE public.categorias ADD COLUMN IF NOT EXISTS subcategorias TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE public.categorias ADD COLUMN IF NOT EXISTS arquivada BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.categorias ADD COLUMN IF NOT EXISTS subcategorias_arquivadas TEXT[] NOT NULL DEFAULT '{}';

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
    fotos_urls TEXT[] NOT NULL DEFAULT '{}',
    maior_idade BOOLEAN NOT NULL DEFAULT false,

    -- Preços e pesquisa de mercado (comparativo visível apenas para o admin)
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

-- Caso a tabela já tenha sido criada antes, adiciona as novas colunas
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS subcategoria TEXT DEFAULT '';
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS fotos_urls TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE public.produtos ADD COLUMN IF NOT EXISTS maior_idade BOOLEAN NOT NULL DEFAULT false;

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

-- Taxa (maquininha/Pix) e frete de cada venda, descontados do lucro no relatório
ALTER TABLE public.vendas ADD COLUMN IF NOT EXISTS taxa NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (taxa >= 0);
ALTER TABLE public.vendas ADD COLUMN IF NOT EXISTS frete NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (frete >= 0);
ALTER TABLE public.vendas ADD COLUMN IF NOT EXISTS forma_pagamento TEXT NOT NULL DEFAULT 'Pix';

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
    p.fotos_urls,
    p.maior_idade,
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
        v_valor_total,
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
-- 8. TABELA E FUNÇÕES SEGURAS DE CADASTRO DE CLIENTES DA VITRINE
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.clientes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome TEXT NOT NULL CHECK (char_length(trim(nome)) >= 2 AND char_length(nome) <= 120),
    email TEXT NOT NULL UNIQUE CHECK (position('@' in email) > 1),
    whatsapp TEXT NOT NULL DEFAULT '',
    endereco TEXT NOT NULL DEFAULT '',
    data_nascimento DATE,
    pais TEXT NOT NULL DEFAULT 'Brasil',
    estado TEXT NOT NULL DEFAULT 'BA',
    cidade TEXT NOT NULL DEFAULT 'Salvador',
    bairro TEXT NOT NULL DEFAULT '',
    rua TEXT NOT NULL DEFAULT '',
    complemento TEXT NOT NULL DEFAULT '',
    senha_hash TEXT NOT NULL,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS data_nascimento DATE;
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS pais TEXT NOT NULL DEFAULT 'Brasil';
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS estado TEXT NOT NULL DEFAULT 'BA';
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS cidade TEXT NOT NULL DEFAULT 'Salvador';
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS bairro TEXT NOT NULL DEFAULT '';
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS rua TEXT NOT NULL DEFAULT '';
ALTER TABLE public.clientes ADD COLUMN IF NOT EXISTS complemento TEXT NOT NULL DEFAULT '';

ALTER TABLE public.clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clientes FORCE ROW LEVEL SECURITY;

-- Visitantes anônimos NÃO podem ler a tabela de clientes diretamente
REVOKE ALL ON TABLE public.clientes FROM anon;
GRANT SELECT ON TABLE public.clientes TO authenticated;

DROP POLICY IF EXISTS "Admin visualiza clientes" ON public.clientes;
CREATE POLICY "Admin visualiza clientes"
    ON public.clientes
    FOR SELECT
    TO authenticated
    USING (true);

-- Remove assinatura antiga (5 parâmetros) caso exista para evitar conflito de sobrecarga no PostgREST
DROP FUNCTION IF EXISTS public.cadastrar_cliente_loja(TEXT, TEXT, TEXT, TEXT, TEXT);

-- Função segura para o cliente se cadastrar na vitrine (com endereço estruturado e data de nascimento)
CREATE OR REPLACE FUNCTION public.cadastrar_cliente_loja(
    p_nome TEXT,
    p_email TEXT,
    p_whatsapp TEXT,
    p_endereco TEXT,
    p_senha TEXT,
    p_data_nascimento DATE DEFAULT NULL,
    p_pais TEXT DEFAULT 'Brasil',
    p_estado TEXT DEFAULT 'BA',
    p_cidade TEXT DEFAULT 'Salvador',
    p_bairro TEXT DEFAULT '',
    p_rua TEXT DEFAULT '',
    p_complemento TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_email_limpo TEXT;
    v_cliente_id UUID;
BEGIN
    v_email_limpo := lower(trim(COALESCE(p_email, '')));

    IF char_length(trim(COALESCE(p_nome, ''))) < 2 THEN
        RAISE EXCEPTION 'Informe seu nome completo.';
    END IF;

    IF position('@' in v_email_limpo) <= 1 THEN
        RAISE EXCEPTION 'Informe um e-mail válido.';
    END IF;

    IF char_length(trim(COALESCE(p_whatsapp, ''))) < 8 THEN
        RAISE EXCEPTION 'Informe seu WhatsApp com DDD.';
    END IF;

    IF char_length(trim(COALESCE(p_endereco, ''))) < 5 THEN
        RAISE EXCEPTION 'O endereço de entrega é obrigatório. Selecione estado, cidade, bairro e rua.';
    END IF;

    IF char_length(COALESCE(p_senha, '')) < 6 THEN
        RAISE EXCEPTION 'A senha deve ter pelo menos 6 caracteres.';
    END IF;

    IF EXISTS (SELECT 1 FROM public.clientes WHERE email = v_email_limpo) THEN
        RAISE EXCEPTION 'Este e-mail já está cadastrado. Faça login na aba Entrar.';
    END IF;

    INSERT INTO public.clientes (
        nome, email, whatsapp, endereco, data_nascimento,
        pais, estado, cidade, bairro, rua, complemento, senha_hash
    )
    VALUES (
        trim(p_nome),
        v_email_limpo,
        trim(COALESCE(p_whatsapp, '')),
        trim(COALESCE(p_endereco, '')),
        p_data_nascimento,
        COALESCE(NULLIF(trim(p_pais), ''), 'Brasil'),
        COALESCE(NULLIF(trim(p_estado), ''), 'BA'),
        COALESCE(NULLIF(trim(p_cidade), ''), 'Salvador'),
        trim(COALESCE(p_bairro, '')),
        trim(COALESCE(p_rua, '')),
        trim(COALESCE(p_complemento, '')),
        crypt(p_senha, gen_salt('bf'))
    )
    RETURNING id INTO v_cliente_id;

    RETURN jsonb_build_object(
        'id', v_cliente_id,
        'nome', trim(p_nome),
        'email', v_email_limpo,
        'whatsapp', trim(COALESCE(p_whatsapp, '')),
        'endereco', trim(COALESCE(p_endereco, '')),
        'data_nascimento', p_data_nascimento,
        'pais', COALESCE(NULLIF(trim(p_pais), ''), 'Brasil'),
        'estado', COALESCE(NULLIF(trim(p_estado), ''), 'BA'),
        'cidade', COALESCE(NULLIF(trim(p_cidade), ''), 'Salvador'),
        'bairro', trim(COALESCE(p_bairro, '')),
        'rua', trim(COALESCE(p_rua, '')),
        'complemento', trim(COALESCE(p_complemento, ''))
    );
END;
$$;

-- Função segura para o cliente fazer login na vitrine
CREATE OR REPLACE FUNCTION public.entrar_cliente_loja(
    p_email TEXT,
    p_senha TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_cliente public.clientes%ROWTYPE;
BEGIN
    SELECT * INTO v_cliente
    FROM public.clientes
    WHERE email = lower(trim(COALESCE(p_email, '')));

    IF NOT FOUND OR v_cliente.senha_hash <> crypt(COALESCE(p_senha, ''), v_cliente.senha_hash) THEN
        RAISE EXCEPTION 'E-mail ou senha incorretos.';
    END IF;

    RETURN jsonb_build_object(
        'id', v_cliente.id,
        'nome', v_cliente.nome,
        'email', v_cliente.email,
        'whatsapp', v_cliente.whatsapp,
        'endereco', v_cliente.endereco,
        'data_nascimento', v_cliente.data_nascimento,
        'pais', v_cliente.pais,
        'estado', v_cliente.estado,
        'cidade', v_cliente.cidade,
        'bairro', v_cliente.bairro,
        'rua', v_cliente.rua,
        'complemento', v_cliente.complemento
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.cadastrar_cliente_loja(TEXT, TEXT, TEXT, TEXT, TEXT, DATE, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.entrar_cliente_loja(TEXT, TEXT) TO anon, authenticated;

-- Função para atualizar data de nascimento de cliente já cadastrado
CREATE OR REPLACE FUNCTION public.atualizar_data_nascimento_cliente(
    p_email TEXT,
    p_data_nascimento DATE
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE public.clientes
    SET data_nascimento = p_data_nascimento
    WHERE email = lower(trim(COALESCE(p_email, '')));
    RETURN FOUND;
END;
$$;

GRANT EXECUTE ON FUNCTION public.atualizar_data_nascimento_cliente(TEXT, DATE) TO anon, authenticated;

-- ============================================================================
-- 9. CATEGORIAS E SUBCATEGORIAS ORGANIZADAS (INCLUINDO BEBIDAS)
-- ============================================================================
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
    ),
    (
        'Bebidas',
        'bebidas',
        ARRAY['Bebidas Alcoólicas', 'Refrigerantes e Sucos', 'Águas e Energéticos'],
        8
    )
ON CONFLICT (slug) DO UPDATE SET
    nome = EXCLUDED.nome,
    subcategorias = EXCLUDED.subcategorias,
    ordem = EXCLUDED.ordem;

-- ============================================================================
-- 10. ÁREAS DE ENTREGA (BAIRROS/REGIÕES COM VALOR DO FRETE)
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.areas_entrega (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome TEXT NOT NULL CHECK (char_length(trim(nome)) > 0 AND char_length(nome) <= 80),
    valor NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (valor >= 0),
    gratis_acima NUMERIC(10, 2) CHECK (gratis_acima IS NULL OR gratis_acima >= 0),
    ativa BOOLEAN NOT NULL DEFAULT true,
    ordem INTEGER NOT NULL DEFAULT 0,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.areas_entrega ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.areas_entrega FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Areas ativas visiveis para todos" ON public.areas_entrega;
DROP POLICY IF EXISTS "Admin gerencia areas de entrega" ON public.areas_entrega;

CREATE POLICY "Areas ativas visiveis para todos"
    ON public.areas_entrega
    FOR SELECT
    TO anon
    USING (ativa = true);

CREATE POLICY "Admin gerencia areas de entrega"
    ON public.areas_entrega
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

REVOKE ALL ON TABLE public.areas_entrega FROM anon;
GRANT SELECT ON TABLE public.areas_entrega TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.areas_entrega TO authenticated;

-- ============================================================================
-- 11. TABELA DE AVALIAÇÕES DOS CLIENTES NOS PRODUTOS
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.avaliacoes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    produto_id UUID NOT NULL REFERENCES public.produtos(id) ON DELETE CASCADE,
    cliente_nome TEXT NOT NULL CHECK (char_length(trim(cliente_nome)) >= 2 AND char_length(cliente_nome) <= 100),
    nota INTEGER NOT NULL CHECK (nota >= 1 AND nota <= 5),
    comentario TEXT NOT NULL DEFAULT '' CHECK (char_length(comentario) <= 600),
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_avaliacoes_produto ON public.avaliacoes(produto_id, criado_em DESC);

ALTER TABLE public.avaliacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.avaliacoes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Avaliacoes visiveis para todos" ON public.avaliacoes;
DROP POLICY IF EXISTS "Clientes enviam avaliacoes" ON public.avaliacoes;
DROP POLICY IF EXISTS "Admin gerencia avaliacoes" ON public.avaliacoes;

CREATE POLICY "Avaliacoes visiveis para todos"
    ON public.avaliacoes
    FOR SELECT
    TO anon, authenticated
    USING (true);

CREATE POLICY "Clientes enviam avaliacoes"
    ON public.avaliacoes
    FOR INSERT
    TO anon, authenticated
    WITH CHECK (nota >= 1 AND nota <= 5 AND char_length(trim(cliente_nome)) >= 2);

CREATE POLICY "Admin gerencia avaliacoes"
    ON public.avaliacoes
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

REVOKE ALL ON TABLE public.avaliacoes FROM anon;
GRANT SELECT, INSERT ON TABLE public.avaliacoes TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.avaliacoes TO authenticated;

-- ============================================================================
-- 12. TABELA E FUNÇÕES SEGURAS PARA PEDIDOS DA VITRINE
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.pedidos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo_pedido TEXT NOT NULL UNIQUE,
    cliente_id UUID REFERENCES public.clientes(id) ON DELETE SET NULL,
    cliente_nome TEXT NOT NULL,
    cliente_email TEXT NOT NULL,
    cliente_whatsapp TEXT NOT NULL,
    tipo_recebimento TEXT NOT NULL DEFAULT 'entrega', -- 'entrega' ou 'retirada'
    endereco_entrega TEXT NOT NULL DEFAULT '',
    itens JSONB NOT NULL DEFAULT '[]'::jsonb,
    subtotal NUMERIC(10, 2) NOT NULL CHECK (subtotal >= 0),
    frete NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (frete >= 0),
    taxa NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (taxa >= 0),
    valor_total NUMERIC(10, 2) NOT NULL CHECK (valor_total >= 0),
    forma_pagamento TEXT NOT NULL DEFAULT 'Pix',
    status TEXT NOT NULL DEFAULT 'Pendente', -- 'Pendente', 'Pago', 'Enviado', 'Entregue', 'Cancelado'
    observacao TEXT DEFAULT '',
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pedidos_criado_em ON public.pedidos(criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_status ON public.pedidos(status);

ALTER TABLE public.pedidos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedidos FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin gerencia pedidos" ON public.pedidos;
CREATE POLICY "Admin gerencia pedidos"
    ON public.pedidos
    FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

REVOKE ALL ON TABLE public.pedidos FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pedidos TO authenticated;

-- Função segura com SECURITY DEFINER para a vitrine registrar o pedido
CREATE OR REPLACE FUNCTION public.registrar_pedido_vitrine(
    p_cliente_id UUID,
    p_cliente_nome TEXT,
    p_cliente_email TEXT,
    p_cliente_whatsapp TEXT,
    p_tipo_recebimento TEXT,
    p_endereco_entrega TEXT,
    p_itens JSONB,
    p_subtotal NUMERIC,
    p_frete NUMERIC,
    p_taxa NUMERIC,
    p_valor_total NUMERIC,
    p_forma_pagamento TEXT,
    p_observacao TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_codigo TEXT;
    v_pedido_id UUID;
BEGIN
    IF char_length(trim(COALESCE(p_cliente_nome, ''))) < 2 THEN
        RAISE EXCEPTION 'Nome do cliente é obrigatório.';
    END IF;
    IF p_valor_total IS NULL OR p_valor_total <= 0 THEN
        RAISE EXCEPTION 'Valor do pedido inválido.';
    END IF;

    -- Gera código amigável tipo PG-XXXX
    v_codigo := 'PG-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));

    INSERT INTO public.pedidos (
        codigo_pedido,
        cliente_id,
        cliente_nome,
        cliente_email,
        cliente_whatsapp,
        tipo_recebimento,
        endereco_entrega,
        itens,
        subtotal,
        frete,
        taxa,
        valor_total,
        forma_pagamento,
        observacao
    )
    VALUES (
        v_codigo,
        p_cliente_id,
        trim(p_cliente_nome),
        lower(trim(COALESCE(p_cliente_email, ''))),
        trim(COALESCE(p_cliente_whatsapp, '')),
        COALESCE(p_tipo_recebimento, 'entrega'),
        COALESCE(p_endereco_entrega, ''),
        COALESCE(p_itens, '[]'::jsonb),
        COALESCE(p_subtotal, 0),
        COALESCE(p_frete, 0),
        COALESCE(p_taxa, 0),
        p_valor_total,
        COALESCE(p_forma_pagamento, 'Pix'),
        COALESCE(p_observacao, '')
    )
    RETURNING id INTO v_pedido_id;

    RETURN jsonb_build_object(
        'id', v_pedido_id,
        'codigo_pedido', v_codigo,
        'valor_total', p_valor_total
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.registrar_pedido_vitrine(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT
) TO anon, authenticated;

