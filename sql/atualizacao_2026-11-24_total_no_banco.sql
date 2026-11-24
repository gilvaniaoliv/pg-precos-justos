-- ============================================================================
-- ATUALIZAÇÃO 2026-11-24: total do pedido calculado no banco
-- Rode este arquivo no SQL Editor do Supabase (não apaga dados).
-- Antes, o total vinha do navegador e podia ser alterado pelo console.
-- ============================================================================

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
-- SEGURANÇA: o navegador NÃO decide preços nem totais.
-- p_subtotal, p_taxa e p_valor_total continuam na assinatura só por compatibilidade
-- e são IGNORADOS. Os preços vêm da tabela produtos e o total é calculado aqui.
DECLARE
    -- Mantenha igual a TAXA_CARTAO_MERCADO_PAGO_PCT em config.js
    c_taxa_cartao_pct CONSTANT NUMERIC := 4.99;
    -- Limite de segurança para o frete informado pela vitrine
    c_frete_maximo CONSTANT NUMERIC := 500;
    v_codigo TEXT;
    v_pedido_id UUID;
    v_item JSONB;
    v_produto RECORD;
    v_qtd INTEGER;
    v_itens JSONB := '[]'::jsonb;
    v_subtotal NUMERIC(10, 2) := 0;
    v_frete NUMERIC(10, 2) := 0;
    v_taxa NUMERIC(10, 2) := 0;
    v_total NUMERIC(10, 2);
    v_tem_maior_idade BOOLEAN := false;
    v_nascimento DATE;
BEGIN
    IF char_length(trim(COALESCE(p_cliente_nome, ''))) < 2 THEN
        RAISE EXCEPTION 'Nome do cliente é obrigatório.';
    END IF;
    IF p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' OR jsonb_array_length(p_itens) = 0 THEN
        RAISE EXCEPTION 'O pedido não tem itens.';
    END IF;
    IF jsonb_array_length(p_itens) > 100 THEN
        RAISE EXCEPTION 'Pedido com itens demais.';
    END IF;

    -- 1. Recalcula cada item com o preço REAL do banco
    FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens) LOOP
        IF COALESCE(v_item->>'quantidade', '') !~ '^[0-9]+$' THEN
            RAISE EXCEPTION 'Quantidade inválida.';
        END IF;
        v_qtd := (v_item->>'quantidade')::INTEGER;
        IF v_qtd < 1 OR v_qtd > 99 THEN
            RAISE EXCEPTION 'Quantidade inválida.';
        END IF;

        SELECT id, nome, preco_venda, estoque, ativo, maior_idade
          INTO v_produto
          FROM public.produtos
         WHERE id::text = v_item->>'id';

        IF NOT FOUND OR NOT v_produto.ativo THEN
            RAISE EXCEPTION 'Um dos produtos não está mais disponível.';
        END IF;
        IF v_produto.estoque < v_qtd THEN
            RAISE EXCEPTION 'Estoque insuficiente para %.', v_produto.nome;
        END IF;
        IF v_produto.maior_idade THEN
            v_tem_maior_idade := true;
        END IF;

        v_subtotal := v_subtotal + v_produto.preco_venda * v_qtd;
        v_itens := v_itens || jsonb_build_array(jsonb_build_object(
            'id', v_produto.id,
            'nome', v_produto.nome,
            'preco_venda', v_produto.preco_venda,
            'quantidade', v_qtd,
            'subtotal', v_produto.preco_venda * v_qtd
        ));
    END LOOP;

    -- 2. Produtos +18 exigem cliente cadastrado com 18 anos ou mais
    IF v_tem_maior_idade THEN
        SELECT data_nascimento INTO v_nascimento FROM public.clientes WHERE id = p_cliente_id;
        IF v_nascimento IS NULL OR age(current_date, v_nascimento) < interval '18 years' THEN
            RAISE EXCEPTION 'Produtos +18 exigem cadastro com data de nascimento e idade mínima de 18 anos.';
        END IF;
    END IF;

    -- 3. Frete: zero na retirada; na entrega, precisa estar dentro do limite
    IF COALESCE(p_tipo_recebimento, 'entrega') = 'retirada' THEN
        v_frete := 0;
    ELSE
        v_frete := COALESCE(p_frete, 0);
        IF v_frete < 0 OR v_frete > c_frete_maximo THEN
            RAISE EXCEPTION 'Valor de frete inválido.';
        END IF;
    END IF;

    -- 4. Taxa do cartão calculada aqui; Pix não tem taxa
    IF COALESCE(p_forma_pagamento, '') ILIKE '%cart%' THEN
        v_taxa := round((v_subtotal + v_frete) * c_taxa_cartao_pct / 100, 2);
    END IF;

    v_total := v_subtotal + v_frete + v_taxa;
    IF v_total <= 0 THEN
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
        v_itens,
        v_subtotal,
        v_frete,
        v_taxa,
        v_total,
        COALESCE(p_forma_pagamento, 'Pix'),
        COALESCE(p_observacao, '')
    )
    RETURNING id INTO v_pedido_id;

    RETURN jsonb_build_object(
        'id', v_pedido_id,
        'codigo_pedido', v_codigo,
        'subtotal', v_subtotal,
        'frete', v_frete,
        'taxa', v_taxa,
        'valor_total', v_total,
        'itens', v_itens
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.registrar_pedido_vitrine(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TEXT, TEXT
) TO anon, authenticated;
