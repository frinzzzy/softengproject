const { EventEmitter } = require('events');

const SOCKET_EVENT_MAP = {
    'order.updated': 'order_updated',
    'stock.updated': 'stock_updated',
    'order.status.updated': 'order_status_updated',
    'order.paid': 'order_paid',
    'order.cancelled': 'order_cancelled',
    'session.cancelled': 'session_cancelled',
    'bill.requested': 'bill_requested',
    'bill.reopened': 'bill_reopened',
    'additional_items_added': 'additional_items_added',
    'table_session_closed': 'table_session_closed'
};

class EventHub extends EventEmitter {
    constructor() {
        super();
        this.io = null;
    }

    setIO(ioInstance) {
        this.io = ioInstance;
    }

    _publish(domainEvent, payload) {
        const socketEvent = SOCKET_EVENT_MAP[domainEvent] || domainEvent;
        this.emit(domainEvent, payload);
        if (!this.io) return payload;

        // Stock updates ay catalog-wide: kailangan makita ng LAHAT ng tables
        // para updated ang menu availability. Huwag i-scope sa isang table.
        if (domainEvent === 'stock.updated') {
            this.io.emit(socketEvent, payload);
            return payload;
        }

        const data = (payload && payload.order) || payload || {};
        const tableId = data.table_id != null ? data.table_id : (payload && payload.table_id);
        const sessionId = data.session_id != null ? data.session_id : (payload && payload.session_id);
        const orderId = data.order_id != null ? data.order_id
            : (data.id != null ? data.id
                : (payload ? (payload.order_id != null ? payload.order_id : payload.id) : null));

        const hasTable = tableId !== null && tableId !== undefined && tableId !== '';
        const hasSession = sessionId !== null && sessionId !== undefined && sessionId !== '';
        const hasOrder = orderId !== null && orderId !== undefined && orderId !== '';

        // Walang specific identifier -> global fallback.
        if (!hasTable && !hasSession && !hasOrder) {
            this.io.emit(socketEvent, payload);
            return payload;
        }

        // Admin at kitchen monitoring ay laging kasama.
        // MAHALAGA: isang chained emit lang (io.to(a).to(b).emit) para hindi
        // doble ang dating sa socket na naka-join sa maraming room — dedupe
        // ang union ng rooms sa isang emit ng socket.io.
        let emitter = this.io.to('admin_live_monitoring').to('kitchen_monitoring');

        if (hasTable) emitter = emitter.to('table_' + tableId);
        if (hasSession) emitter = emitter.to('session_' + sessionId);
        if (hasOrder) emitter = emitter.to('order_' + orderId).to(orderId.toString());

        emitter.emit(socketEvent, payload);
        return payload;
    }

    emitOrderUpdated(payload) { return this._publish('order.updated', payload); }
    emitStockUpdated(payload) { return this._publish('stock.updated', payload); }
    emitOrderStatusUpdated(payload) { return this._publish('order.status.updated', payload); }
    emitOrderPaid(payload) { return this._publish('order.paid', payload); }
    emitOrderCancelled(payload) { return this._publish('order.cancelled', payload); }
    emitSessionCancelled(payload) { return this._publish('session.cancelled', payload); }
    emitBillRequested(payload) { return this._publish('bill.requested', payload); }
    emitBillReopened(payload) { return this._publish('bill.reopened', payload); }
    emitAdditionalItemsAdded(payload) { return this._publish('additional_items_added', payload); }
    emitTableSessionClosed(payload) { return this._publish('table_session_closed', payload); }
}

module.exports = new EventHub();
